// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
//
// MEMORY64 GATE. The go/no-go for the wasm32 -> wasm64 cut-over, in the shape of
// wasm-build/f10-gate.html: answer the question that decides whether the conversion is
// possible BEFORE rebuilding a 4.4 GB dependency stack against it.
//
// The conversion is driven by Tamriel Rebuilt. The shipping build is already at the wasm32
// ceiling -- link-openmw.sh:178-184 links -sINITIAL_MEMORY=1.5GB with -sMAXIMUM_MEMORY=4GiB,
// which is the whole of the 32-bit address space -- so a TR load order has nowhere to go.
//
// What this has to prove, because each one can veto the plan on its own:
//
//  1. MEMORY64 + -pthread + SHARED memory. The engine links -sPTHREAD_POOL_SIZE=8 and
//     play/index.html:694-700 hard-fails without SharedArrayBuffer, so a wasm64 build that
//     cannot do threads is not a build we can ship. This is the least-travelled corner of
//     both emscripten and V8 and it is checked first.
//  2. Allocation PAST 4 GiB. The entire point. If mimalloc (-sMALLOC=mimalloc,
//     link-openmw.sh:184) cannot hand out an address above 4 GiB, the conversion buys
//     nothing and the allocator has to change.
//  3. -fwasm-exceptions across the boundary. Non-negotiable per link-openmw.sh:21-22
//     ("Do NOT add -flto and do NOT set -sWASM_LEGACY_EXCEPTIONS=0").
//  4-6. The three JS<->C++ pointer forms the engine actually uses. MEMORY64 makes a wasm
//     pointer an i64, and that is an ABI change at every one of these sites. They are
//     reproduced VERBATIM from the engine rather than approximated, because the failure mode
//     is a silent null-function crash a long way from the cause -- exactly what
//     link-openmw.sh:85-89 documents for ICU and :150-158 for stale archives.
//
// Build and run: bash wasm-build/memory64-gate.sh

#include <emscripten.h>

#include <atomic>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <thread>
#include <vector>

static int g_fail = 0;

static void ok(const char* name, bool cond, const char* detail = "")
{
    std::printf("%-28s %s %s\n", name, cond ? "PASS" : "FAIL", detail);
    if (!cond)
        ++g_fail;
}

// --- 6. the omw_set_clipboard form ------------------------------------------------------
// engine.cpp:1272 exports `void omw_set_clipboard(const char*)` and play/index.html:1051-1054
// calls it with a pointer it allocated itself. Under MEMORY64 that export takes an i64, so a
// plain JS Number throws -- this is the one hand-written pointer round-trip in the repo's JS
// and the gate has to say whether ccall still marshals it.
static std::string g_clipboard;

extern "C" EMSCRIPTEN_KEEPALIVE void gate_set_clipboard(const char* text)
{
    g_clipboard = text ? text : "(null)";
}

extern "C" EMSCRIPTEN_KEEPALIVE const char* gate_get_clipboard()
{
    return g_clipboard.c_str();
}

// --- 3. wasm exceptions -----------------------------------------------------------------
struct GateError
{
    int code;
};

static bool throw_catch()
{
    try
    {
        throw GateError{ 42 };
    }
    catch (const GateError& e)
    {
        return e.code == 42;
    }
    catch (...)
    {
        return false;
    }
}

// --- 1. threads through a std::atomic ---------------------------------------------------
static bool threads_work()
{
    constexpr int kThreads = 8; // matches -sPTHREAD_POOL_SIZE=8
    std::atomic<int> counter{ 0 };
    std::vector<std::thread> pool;
    pool.reserve(kThreads);
    for (int i = 0; i < kThreads; ++i)
        pool.emplace_back([&counter] {
            for (int j = 0; j < 1000; ++j)
                counter.fetch_add(1, std::memory_order_relaxed);
        });
    for (auto& t : pool)
        t.join();
    return counter.load() == kThreads * 1000;
}

// --- 2. allocate past 4 GiB -------------------------------------------------------------
// Chunked rather than one huge malloc: the engine's allocation profile is many mid-sized
// blocks (cells, meshes, textures), and a single 5 GiB request is a different question from
// the one we actually need answered. Every chunk is written at both ends and read back --
// an address above 4 GiB that silently wraps to the low 32 bits would otherwise look fine.
// The high half of an address, or the low half on the 32-bit control where there is no high
// half to take -- `addr >> 32` on a 32-bit uintptr_t is undefined behaviour and warns.
static char addr_tag(std::uintptr_t addr)
{
    if constexpr (sizeof(std::uintptr_t) > 4)
        return static_cast<char>((addr >> 32) & 0xff);
    else
        return static_cast<char>((addr >> 16) & 0xff);
}

static bool alloc_past_4gib(std::uintptr_t& highest_out, std::size_t& total_out)
{
    constexpr std::size_t kChunk = 256u * 1024u * 1024u; // 256 MiB
    constexpr std::uintptr_t k4GiB = 4ull * 1024 * 1024 * 1024;
    // The wasm32 control cannot reach 4 GiB by definition -- that is the wall this whole
    // change exists to leave. Asking it to try does not produce a useful FAIL, it produces a
    // `RuntimeError: unreachable` from mimalloc aborting, which kills the run before the
    // JS->C++ pointer questions get asked at all. Cap it low enough to survive so the two
    // builds stay comparable on everything EXCEPT the ceiling.
    const std::size_t kTarget = sizeof(void*) == 8
        ? 5ull * 1024 * 1024 * 1024 // 5 GiB, comfortably past the wasm32 wall
        : 512ull * 1024 * 1024; // control: just enough to exercise growth, nowhere near it

    std::vector<char*> blocks;
    std::size_t total = 0;
    std::uintptr_t highest = 0;
    bool wrapped = false;

    while (total < kTarget)
    {
        char* p = static_cast<char*>(std::malloc(kChunk));
        if (!p)
            break;
        // Touch both ends, with a value derived from the address so a wrapped or aliased
        // mapping shows up as a mismatch rather than as a plausible zero.
        const auto addr = reinterpret_cast<std::uintptr_t>(p);
        const char tag = addr_tag(addr);
        p[0] = tag;
        p[kChunk - 1] = static_cast<char>(tag + 1);
        if (p[0] != tag || p[kChunk - 1] != static_cast<char>(tag + 1))
            wrapped = true;
        highest = addr + kChunk > highest ? addr + kChunk : highest;
        blocks.push_back(p);
        total += kChunk;
    }

    // Re-read every block AFTER the heap has finished growing. Growth moves the underlying
    // ArrayBuffer, and this is where a stale-view bug would surface.
    for (char* p : blocks)
    {
        const auto addr = reinterpret_cast<std::uintptr_t>(p);
        const char tag = addr_tag(addr);
        if (p[0] != tag || p[kChunk - 1] != static_cast<char>(tag + 1))
            wrapped = true;
    }

    for (char* p : blocks)
        std::free(p);

    highest_out = highest;
    total_out = total;
    return !wrapped && highest > k4GiB;
}

// --- 7. what MEMORY64 costs ---------------------------------------------------------------
// V8 bounds-checks 64-bit memory accesses differently from 32-bit ones, and this is a GAME: a
// large regression changes the calculus even though the ceiling is the point. Deliberately
// memory-bound rather than a compute loop -- scattered reads are where the model change shows
// up, and that is closer to what OSG's scene traversal does than a tight FLOP loop would be.
// Reported, never asserted: the number that decides anything is the engine's own frame time in
// the same scene (see the plan's Verification step), not this microbenchmark.
static double memory_bound_ns_per_op()
{
    constexpr std::size_t kN = 1u << 24; // 16 Mi entries = 64 MiB per array
    constexpr int kPasses = 4;
    std::vector<std::uint32_t> idx(kN);
    // Strided by a large odd constant so the prefetcher cannot simply walk ahead of us.
    for (std::size_t i = 0; i < kN; ++i)
        idx[i] = static_cast<std::uint32_t>((i * 2654435761u) % kN);

    std::vector<std::uint32_t> data(kN, 1u);
    const double t0 = emscripten_get_now();
    std::uint64_t acc = 0;
    for (int p = 0; p < kPasses; ++p)
        for (std::size_t i = 0; i < kN; ++i)
            acc += data[idx[i]];
    const double t1 = emscripten_get_now();
    if (acc == 0) // keep acc observable so the loop cannot be optimised away
        std::printf("(unreachable %llu)\n", static_cast<unsigned long long>(acc));
    return (t1 - t0) * 1e6 / static_cast<double>(kN * kPasses); // ms -> ns per access
}

int main()
{
    const bool wasm64 = sizeof(void*) == 8;
    std::printf("--- memory64 gate (wasm%s) ---\n", wasm64 ? "64" : "32 CONTROL");
    std::printf("sizeof(void*) = %zu\n", sizeof(void*));
    if (wasm64)
        ok("pointer-is-64-bit", true);
    else
        std::printf("%-28s N/A  (control build)\n", "pointer-is-64-bit");

    ok("wasm-exceptions", throw_catch());
    ok("pthreads+atomic", threads_work());

    std::uintptr_t highest = 0;
    std::size_t total = 0;
    const bool past4 = alloc_past_4gib(highest, total);
    char detail[128];
    std::snprintf(detail, sizeof(detail), "(committed %.2f GiB, highest addr %.2f GiB)",
        static_cast<double>(total) / (1024.0 * 1024 * 1024),
        static_cast<double>(highest) / (1024.0 * 1024 * 1024));
    if (sizeof(void*) == 8)
        ok("alloc-past-4GiB", past4, detail);
    else
        // Expected on the control: this is the ceiling being demonstrated, not a regression.
        std::printf("%-28s N/A  %s (wasm32 cannot exceed 4 GiB -- this is the point)\n",
            "alloc-past-4GiB", detail);

    // --- 4. EM_ASM with a char* argument ------------------------------------------------
    // The form at luabindings.cpp:416,436, engine.cpp:490 and shadermanager.cpp:925-927.
    // Under MEMORY64 $0 arrives in JS as a BigInt; the question is whether UTF8ToString
    // still accepts it.
    {
        const std::string key = "gate.key";
        const std::string value = "gate-value-\xc3\xa9"; // non-ASCII: UTF-8 round-trip too
        int matched = EM_ASM_INT(
            {
                var k = UTF8ToString($0);
                var v = UTF8ToString($1);
                globalThis.__gateKey = k;
                globalThis.__gateValue = v;
                return (k === 'gate.key' && v === 'gate-value-é') ? 1 : 0;
            },
            key.c_str(), value.c_str());
        ok("EM_ASM char* arg", matched == 1);
    }

    // --- 5. EM_ASM_PTR returning stringToNewUTF8 ----------------------------------------
    // Verbatim the form at luabindings.cpp:453,472 -- the MP auth-token and command paths.
    // A failure here is silent MP breakage, so it is checked with a non-ASCII payload and
    // the memory is freed exactly as the engine frees it.
    {
        char* token = static_cast<char*>(EM_ASM_PTR({
            var t = 'tok-é-' + '0123456789';
            return stringToNewUTF8(t);
        }));
        const bool got = token != nullptr && std::strcmp(token, "tok-\xc3\xa9-0123456789") == 0;
        std::free(token);
        ok("EM_ASM_PTR return", got);
    }

    // --- 6. the JS->C++ exported-pointer call -------------------------------------------
    // Driven from JS by the harness after main() returns; main only proves the export links.
    ok("clipboard export linked", &gate_set_clipboard != nullptr);

    std::printf("--- %s (%d failure%s) ---\n", g_fail ? "GATE FAILED" : "GATE PASSED", g_fail,
        g_fail == 1 ? "" : "s");
    std::printf("%-28s %.3f ns/access (memory-bound; compare wasm32 vs wasm64)\n", "perf",
        memory_bound_ns_per_op());
    std::fflush(stdout);
    return g_fail == 0 ? 0 : 1;
}
