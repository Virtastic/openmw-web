// Added by Virtastic (https://virtastic.app) for the OpenMW-Web port, 2026.
// See WASM_ADAPTATIONS.md at the repository root for details.
#include "websocket.hpp"

#ifdef __EMSCRIPTEN__

#include <emscripten/websocket.h>

#include <components/debug/debuglog.hpp>

namespace MWMP
{
    // em_websocket_*_callback_func bridges: userData is the WebSocket*. All handlers only
    // forward into the owner's std::function callbacks (which themselves only enqueue).
    struct WebSocketCallbackBridge
    {
        static bool onOpen(int, const EmscriptenWebSocketOpenEvent*, void* userData)
        {
            auto* self = static_cast<WebSocket*>(userData);
            self->mOpen = true;
            if (self->mCallbacks.mOnOpen)
                self->mCallbacks.mOnOpen();
            return true;
        }

        static bool onMessage(int, const EmscriptenWebSocketMessageEvent* e, void* userData)
        {
            auto* self = static_cast<WebSocket*>(userData);
            if (self->mCallbacks.mOnMessage)
            {
                // For text frames numBytes includes the null terminator — strip it.
                size_t size = e->numBytes;
                if (e->isText && size > 0)
                    size -= 1;
                self->mCallbacks.mOnMessage(e->data, size, e->isText);
            }
            return true;
        }

        static bool onError(int, const EmscriptenWebSocketErrorEvent*, void* userData)
        {
            auto* self = static_cast<WebSocket*>(userData);
            if (self->mCallbacks.mOnError)
                self->mCallbacks.mOnError();
            return true;
        }

        static bool onClose(int, const EmscriptenWebSocketCloseEvent* e, void* userData)
        {
            auto* self = static_cast<WebSocket*>(userData);
            self->mOpen = false;
            if (self->mCallbacks.mOnClose)
                self->mCallbacks.mOnClose(e->code, e->reason, e->wasClean);
            return true;
        }
    };

    WebSocket::~WebSocket()
    {
        if (mSocket)
            emscripten_websocket_delete(mSocket);
    }

    bool WebSocket::open(const std::string& url, const std::string& subprotocol)
    {
        if (mSocket)
            return false;
        if (!emscripten_websocket_is_supported())
        {
            Log(Debug::Error) << "[mp] WebSocket API not supported in this environment";
            return false;
        }
        EmscriptenWebSocketCreateAttributes attr;
        emscripten_websocket_init_create_attributes(&attr);
        attr.url = url.c_str();
        attr.protocols = subprotocol.c_str();
        attr.createOnMainThread = true;
        EMSCRIPTEN_WEBSOCKET_T ws = emscripten_websocket_new(&attr);
        if (ws <= 0)
        {
            Log(Debug::Error) << "[mp] emscripten_websocket_new failed: " << ws;
            return false;
        }
        mSocket = ws;
        mOpen = false;
        emscripten_websocket_set_onopen_callback(ws, this, WebSocketCallbackBridge::onOpen);
        emscripten_websocket_set_onmessage_callback(ws, this, WebSocketCallbackBridge::onMessage);
        emscripten_websocket_set_onerror_callback(ws, this, WebSocketCallbackBridge::onError);
        emscripten_websocket_set_onclose_callback(ws, this, WebSocketCallbackBridge::onClose);
        return true;
    }

    void WebSocket::close(uint16_t code, const std::string& reason)
    {
        if (!mSocket)
            return;
        emscripten_websocket_close(mSocket, code, reason.c_str());
        emscripten_websocket_delete(mSocket);
        mSocket = 0;
        mOpen = false;
    }

    bool WebSocket::sendBinary(const void* data, size_t size)
    {
        if (!mOpen)
            return false;
        return emscripten_websocket_send_binary(mSocket, const_cast<void*>(data), static_cast<uint32_t>(size))
            == EMSCRIPTEN_RESULT_SUCCESS;
    }

    bool WebSocket::sendText(const std::string& str)
    {
        if (!mOpen)
            return false;
        return emscripten_websocket_send_utf8_text(mSocket, str.c_str()) == EMSCRIPTEN_RESULT_SUCCESS;
    }

    size_t WebSocket::bufferedAmount() const
    {
        if (!mSocket)
            return 0;
        size_t amount = 0;
        emscripten_websocket_get_buffered_amount(mSocket, &amount);
        return amount;
    }
}

namespace MWMP
{
    // Browser: callbacks already arrive as separate main-thread tasks between frames.
    void WebSocket::poll() {}
}

#else // !__EMSCRIPTEN__ — real client transport for the headless sim peer (Phase H2).

// Hand-rolled RFC 6455 CLIENT, ws:// only, deliberately dependency-free. The peer connects
// to our own server over localhost/LAN (TLS termination is the browser path's concern, at
// the reverse proxy), so the subset is small and fully known: no wss, no proxies, no
// extensions offered (so the server cannot negotiate permessage-deflate), text/binary with
// fragmentation reassembly, auto-pong, clean close.
//
// THREADING: one blocking reader thread parses frames and enqueues events; poll() (main
// thread, once per frame from NetManager::pumpInboundToLua) drains the queue and fires
// mCallbacks. Callbacks are NEVER fired from the reader thread — NetManager mutates its
// state inline in them and is only safe because the emscripten path delivers callbacks
// between frames; poll() reproduces that contract. Writes (main thread sends + reader
// thread auto-pong) are serialized by a write mutex.

#include <arpa/inet.h>
#include <netdb.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <condition_variable>
#include <cstring>
#include <mutex>
#include <random>
#include <sstream>
#include <thread>
#include <vector>

#include <components/debug/debuglog.hpp>

namespace
{
    // ---- tiny SHA-1 (for Sec-WebSocket-Accept verification only; not security-critical
    // beyond detecting a non-WebSocket endpoint, but verifying is cheap and correct).
    struct Sha1
    {
        uint32_t h[5] = { 0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0 };
        static uint32_t rol(uint32_t v, int b) { return (v << b) | (v >> (32 - b)); }
        void block(const uint8_t* p)
        {
            uint32_t w[80];
            for (int i = 0; i < 16; i++)
                w[i] = (uint32_t(p[i * 4]) << 24) | (uint32_t(p[i * 4 + 1]) << 16)
                    | (uint32_t(p[i * 4 + 2]) << 8) | uint32_t(p[i * 4 + 3]);
            for (int i = 16; i < 80; i++)
                w[i] = rol(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
            uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4];
            for (int i = 0; i < 80; i++)
            {
                uint32_t f, k;
                if (i < 20) { f = (b & c) | (~b & d); k = 0x5A827999; }
                else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
                else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
                else { f = b ^ c ^ d; k = 0xCA62C1D6; }
                uint32_t t = rol(a, 5) + f + e + k + w[i];
                e = d; d = c; c = rol(b, 30); b = a; a = t;
            }
            h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e;
        }
        std::vector<uint8_t> digest(const std::string& msg)
        {
            std::vector<uint8_t> data(msg.begin(), msg.end());
            const uint64_t bitLen = uint64_t(data.size()) * 8;
            data.push_back(0x80);
            while (data.size() % 64 != 56)
                data.push_back(0);
            for (int i = 7; i >= 0; i--)
                data.push_back(uint8_t((bitLen >> (8 * i)) & 0xff));
            for (size_t off = 0; off < data.size(); off += 64)
                block(data.data() + off);
            std::vector<uint8_t> out(20);
            for (int i = 0; i < 5; i++)
                for (int j = 0; j < 4; j++)
                    out[i * 4 + j] = uint8_t((h[i] >> (8 * (3 - j))) & 0xff);
            return out;
        }
    };

    std::string base64(const uint8_t* data, size_t len)
    {
        static const char* tbl = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        std::string out;
        for (size_t i = 0; i < len; i += 3)
        {
            uint32_t v = uint32_t(data[i]) << 16;
            if (i + 1 < len) v |= uint32_t(data[i + 1]) << 8;
            if (i + 2 < len) v |= uint32_t(data[i + 2]);
            out += tbl[(v >> 18) & 63];
            out += tbl[(v >> 12) & 63];
            out += (i + 1 < len) ? tbl[(v >> 6) & 63] : '=';
            out += (i + 2 < len) ? tbl[v & 63] : '=';
        }
        return out;
    }

    bool writeAll(int fd, const uint8_t* p, size_t n)
    {
        while (n > 0)
        {
            ssize_t w = ::write(fd, p, n);
            if (w <= 0)
                return false;
            p += w;
            n -= size_t(w);
        }
        return true;
    }

    bool readAll(int fd, uint8_t* p, size_t n)
    {
        while (n > 0)
        {
            ssize_t r = ::read(fd, p, n);
            if (r <= 0)
                return false;
            p += r;
            n -= size_t(r);
        }
        return true;
    }
}

namespace MWMP
{
    struct WebSocket::NativeState
    {
        enum class Kind { Open, Message, Error, Close };
        struct Event
        {
            Kind kind;
            std::vector<uint8_t> payload;
            bool isText = false;
            uint16_t code = 0;
            std::string reason;
        };

        int fd = -1;
        std::thread reader;
        std::mutex writeMutex; // main-thread sends + reader-thread auto-pong
        std::mutex queueMutex;
        std::vector<Event> queue;
        std::atomic<bool> closing{ false };

        void push(Event e)
        {
            std::lock_guard<std::mutex> lk(queueMutex);
            queue.push_back(std::move(e));
        }

        // Client frames MUST be masked (RFC 6455 §5.3); the server rejects unmasked ones.
        bool sendFrame(uint8_t opcode, const uint8_t* data, size_t n)
        {
            std::vector<uint8_t> f;
            f.reserve(n + 14);
            f.push_back(0x80 | opcode); // FIN + opcode; we never fragment outbound
            if (n < 126)
                f.push_back(0x80 | uint8_t(n));
            else if (n <= 0xffff)
            {
                f.push_back(0x80 | 126);
                f.push_back(uint8_t(n >> 8));
                f.push_back(uint8_t(n));
            }
            else
            {
                f.push_back(0x80 | 127);
                for (int i = 7; i >= 0; i--)
                    f.push_back(uint8_t((uint64_t(n) >> (8 * i)) & 0xff));
            }
            static thread_local std::mt19937 rng{ std::random_device{}() };
            uint8_t mask[4];
            const uint32_t m = rng();
            std::memcpy(mask, &m, 4);
            f.insert(f.end(), mask, mask + 4);
            const size_t base = f.size();
            f.resize(base + n);
            for (size_t i = 0; i < n; i++)
                f[base + i] = data[i] ^ mask[i & 3];
            std::lock_guard<std::mutex> lk(writeMutex);
            return writeAll(fd, f.data(), f.size());
        }

        // Reader thread: parse until close/error. Control frames may interleave with a
        // fragmented message, so reassembly state lives outside the frame loop.
        void run()
        {
            std::vector<uint8_t> assembled;
            uint8_t assembledOp = 0;
            for (;;)
            {
                uint8_t hdr[2];
                if (!readAll(fd, hdr, 2))
                    break;
                const bool fin = hdr[0] & 0x80;
                const uint8_t op = hdr[0] & 0x0f;
                uint64_t len = hdr[1] & 0x7f;
                if (hdr[1] & 0x80)
                    break; // server frames must not be masked
                if (len == 126)
                {
                    uint8_t ext[2];
                    if (!readAll(fd, ext, 2))
                        break;
                    len = (uint64_t(ext[0]) << 8) | ext[1];
                }
                else if (len == 127)
                {
                    uint8_t ext[8];
                    if (!readAll(fd, ext, 8))
                        break;
                    len = 0;
                    for (int i = 0; i < 8; i++)
                        len = (len << 8) | ext[i];
                }
                if (len > (64u << 20))
                    break; // 64 MB sanity bound, far above maxMsgBytes
                std::vector<uint8_t> payload(len);
                if (len && !readAll(fd, payload.data(), len))
                    break;

                if (op == 0x8) // close
                {
                    uint16_t code = 1005;
                    std::string reason;
                    if (payload.size() >= 2)
                    {
                        code = uint16_t((payload[0] << 8) | payload[1]);
                        reason.assign(payload.begin() + 2, payload.end());
                    }
                    if (!closing.exchange(true))
                        sendFrame(0x8, payload.data(), std::min<size_t>(payload.size(), 125));
                    push({ Kind::Close, {}, false, code, std::move(reason) });
                    return;
                }
                if (op == 0x9) // ping -> pong, same payload
                {
                    sendFrame(0xA, payload.data(), payload.size());
                    continue;
                }
                if (op == 0xA) // pong: nothing to do (server keepalive is WS-level ping)
                    continue;

                if (op == 0x1 || op == 0x2) // text / binary, possibly fragmented
                {
                    if (!fin)
                    {
                        assembledOp = op;
                        assembled = std::move(payload);
                        continue;
                    }
                    push({ Kind::Message, std::move(payload), op == 0x1 });
                }
                else if (op == 0x0) // continuation
                {
                    assembled.insert(assembled.end(), payload.begin(), payload.end());
                    if (fin)
                    {
                        push({ Kind::Message, std::move(assembled), assembledOp == 0x1 });
                        assembled.clear();
                        assembledOp = 0;
                    }
                }
            }
            push({ Kind::Error, {}, false, 0, {} });
            push({ Kind::Close, {}, false, 1006, "abnormal closure" });
        }
    };

    WebSocket::~WebSocket()
    {
        close(1000, "shutdown");
    }

    bool WebSocket::open(const std::string& url, const std::string& subprotocol)
    {
        // ws://host[:port]/path — wss is deliberately unsupported: the peer talks to its own
        // server directly, not through the public TLS edge.
        if (url.rfind("ws://", 0) != 0)
        {
            Log(Debug::Error) << "[mp] native transport supports ws:// only, got: " << url;
            return false;
        }
        std::string rest = url.substr(5);
        const size_t slash = rest.find('/');
        std::string hostport = rest.substr(0, slash);
        std::string path = slash == std::string::npos ? "/" : rest.substr(slash);
        std::string host = hostport;
        std::string port = "80";
        const size_t colon = hostport.rfind(':');
        if (colon != std::string::npos)
        {
            host = hostport.substr(0, colon);
            port = hostport.substr(colon + 1);
        }

        addrinfo hints{};
        hints.ai_family = AF_UNSPEC;
        hints.ai_socktype = SOCK_STREAM;
        addrinfo* res = nullptr;
        if (getaddrinfo(host.c_str(), port.c_str(), &hints, &res) != 0 || !res)
        {
            Log(Debug::Error) << "[mp] resolve failed for " << host;
            return false;
        }
        int fd = -1;
        for (addrinfo* ai = res; ai; ai = ai->ai_next)
        {
            fd = ::socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol);
            if (fd < 0)
                continue;
            if (::connect(fd, ai->ai_addr, ai->ai_addrlen) == 0)
                break;
            ::close(fd);
            fd = -1;
        }
        freeaddrinfo(res);
        if (fd < 0)
        {
            Log(Debug::Error) << "[mp] connect failed to " << host << ":" << port;
            return false;
        }

        // HTTP upgrade. The key is random per connection; the Accept check below is what
        // catches "that port is not actually a WebSocket server".
        uint8_t keyBytes[16];
        std::random_device rd;
        for (auto& b : keyBytes)
            b = uint8_t(rd());
        const std::string key = base64(keyBytes, 16);
        std::ostringstream req;
        req << "GET " << path << " HTTP/1.1\r\nHost: " << hostport
            << "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: " << key
            << "\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: " << subprotocol << "\r\n\r\n";
        const std::string reqStr = req.str();
        if (!writeAll(fd, reinterpret_cast<const uint8_t*>(reqStr.data()), reqStr.size()))
        {
            ::close(fd);
            return false;
        }
        // Read headers byte-wise to \r\n\r\n so no frame bytes are swallowed.
        std::string resp;
        char c;
        while (resp.find("\r\n\r\n") == std::string::npos)
        {
            if (::read(fd, &c, 1) <= 0 || resp.size() > 16384)
            {
                ::close(fd);
                return false;
            }
            resp += c;
        }
        const std::string expected = base64(Sha1().digest(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").data(), 20);
        if (resp.find(" 101 ") == std::string::npos || resp.find(expected) == std::string::npos)
        {
            Log(Debug::Error) << "[mp] websocket handshake refused";
            ::close(fd);
            return false;
        }

        mNative = new NativeState();
        mNative->fd = fd;
        mSocket = 1;
        mNative->push({ NativeState::Kind::Open, {}, false, 0, {} });
        mNative->reader = std::thread([ns = mNative] { ns->run(); });
        return true;
    }

    void WebSocket::poll()
    {
        if (!mNative)
            return;
        std::vector<NativeState::Event> events;
        {
            std::lock_guard<std::mutex> lk(mNative->queueMutex);
            events.swap(mNative->queue);
        }
        for (auto& e : events)
        {
            switch (e.kind)
            {
                case NativeState::Kind::Open:
                    mOpen = true;
                    if (mCallbacks.mOnOpen)
                        mCallbacks.mOnOpen();
                    break;
                case NativeState::Kind::Message:
                    if (mCallbacks.mOnMessage)
                        mCallbacks.mOnMessage(e.payload.data(), e.payload.size(), e.isText);
                    break;
                case NativeState::Kind::Error:
                    if (mCallbacks.mOnError)
                        mCallbacks.mOnError();
                    break;
                case NativeState::Kind::Close:
                {
                    mOpen = false;
                    const bool wasClean = e.code != 1006;
                    if (mCallbacks.mOnClose)
                        mCallbacks.mOnClose(e.code, e.reason, wasClean);
                    break;
                }
            }
        }
    }

    void WebSocket::close(uint16_t code, const std::string& reason)
    {
        if (!mNative)
            return;
        if (!mNative->closing.exchange(true))
        {
            uint8_t body[125];
            body[0] = uint8_t(code >> 8);
            body[1] = uint8_t(code);
            const size_t rlen = std::min(reason.size(), size_t(123));
            std::memcpy(body + 2, reason.data(), rlen);
            mNative->sendFrame(0x8, body, 2 + rlen);
        }
        ::shutdown(mNative->fd, SHUT_RDWR);
        if (mNative->reader.joinable())
            mNative->reader.join();
        ::close(mNative->fd);
        delete mNative;
        mNative = nullptr;
        mSocket = 0;
        mOpen = false;
    }

    bool WebSocket::sendBinary(const void* data, size_t size)
    {
        return mNative && mNative->sendFrame(0x2, static_cast<const uint8_t*>(data), size);
    }

    bool WebSocket::sendText(const std::string& str)
    {
        return mNative && mNative->sendFrame(0x1, reinterpret_cast<const uint8_t*>(str.data()), str.size());
    }

    size_t WebSocket::bufferedAmount() const
    {
        // Blocking writes to a localhost peer: nothing is ever queued in userspace. The
        // client-side shed logic therefore never triggers for the peer, which is correct —
        // a sim peer that cannot drain to a same-host server has bigger problems.
        return 0;
    }
}

#endif
