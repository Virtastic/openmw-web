// Modified by Virtastic (https://virtastic.app) for the OpenMW-Web port, 2025-2026.
// See WASM_ADAPTATIONS.md at the repository root for details of the changes.
#include "debuglog.hpp"

#include <mutex>

#include <components/files/conversion.hpp>
#include <components/misc/strings/conversion.hpp>

static std::mutex sLock;

// Default to Info (not All): worker threads (physics/navmesh) read this shared static, and before
// setupLogging() applies the configured level — or if a worker reads it without a barrier — the old
// Debug::All default let per-job DetourNavigator Debug logs flood the browser console. Info is the
// sane release floor; setupLogging() still applies OPENMW_DEBUG_LEVEL on the main path.
Debug::Level Log::sMinDebugLevel = Debug::Info;
bool Log::sWriteLevel = false;

Log::Log(Debug::Level level)
    : mShouldLog(level <= sMinDebugLevel)
{
    // No need to hold the lock if there will be no logging anyway
    if (!mShouldLog)
        return;

    // Locks a global lock while the object is alive
    sLock.lock();

    if (!sWriteLevel)
        return;

    std::cout << static_cast<unsigned char>(level);
}

Log::~Log()
{
    if (!mShouldLog)
        return;

    std::cout << std::endl;
    sLock.unlock();
}

Log& Log::operator<<(const std::filesystem::path& rhs)
{
    if (mShouldLog)
        std::cout << Files::pathToUnicodeString(rhs);

    return *this;
}

Log& Log::operator<<(const std::u8string& rhs)
{
    if (mShouldLog)
        std::cout << Misc::StringUtils::u8StringToString(rhs);

    return *this;
}

Log& Log::operator<<(const std::u8string_view rhs)
{
    if (mShouldLog)
        std::cout << Misc::StringUtils::u8StringToString(rhs);

    return *this;
}

Log& Log::operator<<(const char8_t* rhs)
{
    if (mShouldLog)
        std::cout << Misc::StringUtils::u8StringToString(rhs);

    return *this;
}
