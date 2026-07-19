// Added by Virtastic (https://virtastic.app) for the OpenMW-Web port, 2026.
// See WASM_ADAPTATIONS.md at the repository root for details.
#include "netmanager.hpp"

#include <cstring>

#include <components/debug/debuglog.hpp>

#include "../mwlua/luaevents.hpp"

namespace MWMP
{
    namespace
    {
        // Minimal LSER encoder for a bare string (components/lua/serialization.cpp FORMAT_VERSION 0):
        // version byte, then 0b001SSSSS short form (<32 bytes) or LONG_STRING 0x1 + u32 LE length.
        // Lets the transport hand session JSON to Lua without touching the Lua state.
        std::string lserString(std::string_view str)
        {
            std::string out;
            out.push_back('\0'); // FORMAT_VERSION 0
            if (str.size() < 32)
                out.push_back(static_cast<char>(0x20 | str.size()));
            else
            {
                out.push_back(0x1); // LONG_STRING
                uint32_t size = static_cast<uint32_t>(str.size());
                for (int i = 0; i < 4; ++i)
                    out.push_back(static_cast<char>((size >> (8 * i)) & 0xff));
            }
            out.append(str);
            return out;
        }

        template <typename T>
        T readLE(const uint8_t* p)
        {
            T v = 0;
            for (size_t i = 0; i < sizeof(T); ++i)
                v |= static_cast<T>(p[i]) << (8 * i);
            return v;
        }

        template <typename T>
        void appendLE(std::string& out, T v)
        {
            for (size_t i = 0; i < sizeof(T); ++i)
                out.push_back(static_cast<char>((v >> (8 * i)) & 0xff));
        }

        constexpr uint16_t sTypeEvent = 0x0002; // PROTOCOL.md binary type registry
    }

    NetManager& NetManager::instance()
    {
        static NetManager manager;
        return manager;
    }

    bool NetManager::connect(const std::string& url)
    {
        // A server-initiated close leaves the dead handle behind (deleting it inside the WS
        // close callback is unsafe); reap it here so Lua can reconnect (register->login flow).
        if (mSocket.isConnected() && !mSocket.isOpen() && mSocketDead)
            mSocket.close(1000, "reconnect");
        if (mSocket.isConnected())
            return false;
        mSocketDead = false;
        mSocket.setCallbacks({
            [this] { mOpenPending = true; },
            [this](const uint8_t* data, size_t size, bool isText) { onMessage(data, size, isText); },
            [this] { onClose(0, "websocket error"); },
            [this](uint16_t code, std::string reason, bool) { onClose(code, std::move(reason)); },
        });
        // PROTOCOL.md names the subprotocol "omw-mp/1", but '/' is not a valid RFC 6455
        // subprotocol token and browsers refuse to construct the WebSocket. The server
        // accepts "omw-mp.1" as the canonical wire form (SUBPROTOCOL in server/src).
        if (!mSocket.open(url, "omw-mp.1"))
            return false;
        mState = State::Connecting;
        mSeq = 0;
        mCloseCode = 0;
        mCloseReason.clear();
        return true;
    }

    void NetManager::disconnect()
    {
        if (mSocket.isConnected())
            mSocket.close(1000, "client disconnect");
        mState = State::Offline;
        mOutbound.clear();
    }

    void NetManager::setSessionState(std::string_view name)
    {
        if (name == "Offline")
            mState = State::Offline;
        else if (name == "Connecting")
            mState = State::Connecting;
        else if (name == "HelloSent")
            mState = State::HelloSent;
        else if (name == "Authing")
            mState = State::Authing;
        else if (name == "Joined")
            mState = State::Joined;
        else if (name == "Failed")
            mState = State::Failed;
        else
            Log(Debug::Warning) << "[mp] unknown session state '" << name << "'";
    }

    std::string_view NetManager::stateName() const
    {
        switch (mState)
        {
            case State::Offline:
                return "Offline";
            case State::Connecting:
                return "Connecting";
            case State::HelloSent:
                return "HelloSent";
            case State::Authing:
                return "Authing";
            case State::Joined:
                return "Joined";
            case State::Failed:
                return "Failed";
        }
        return "Offline";
    }

    bool NetManager::sendEvent(std::string_view name, const std::string& lserBody)
    {
        if (!mSocket.isConnected())
            return false;
        if (name.empty() || name.size() > 255)
        {
            Log(Debug::Error) << "[mp] bad event name length " << name.size();
            return false;
        }
        std::string frame;
        frame.reserve(6 + 1 + name.size() + lserBody.size());
        appendLE<uint16_t>(frame, sTypeEvent);
        appendLE<uint32_t>(frame, ++mSeq);
        frame.push_back(static_cast<char>(name.size()));
        frame.append(name);
        frame.append(lserBody);
        mOutbound.push_back({ false, std::move(frame) });
        return true;
    }

    bool NetManager::sendJson(const std::string& json)
    {
        if (!mSocket.isConnected())
            return false;
        mOutbound.push_back({ true, json });
        return true;
    }

    void NetManager::onMessage(const uint8_t* data, size_t size, bool isText)
    {
        if (mInboundBytes + size > sInboundCap)
        {
            ++mStats.mDroppedInbound;
            return;
        }
        mInbound.push_back({ isText, std::string(reinterpret_cast<const char*>(data), size) });
        mInboundBytes += size;
        mStats.mBytesIn += size;
        ++mStats.mMsgsIn;
    }

    void NetManager::onClose(uint16_t code, std::string reason)
    {
        mSocketDead = true;
        mClosePending = true;
        mCloseCode = code;
        mCloseReason = std::move(reason);
        if (mState != State::Failed)
            mState = State::Offline;
        mOutbound.clear();
    }

    void NetManager::pumpInboundToLua(MWLua::LuaEvents& events)
    {
        if (mOpenPending)
        {
            mOpenPending = false;
            events.addGlobalEvent({ "MP_TransportOpen", {} });
        }
        while (!mInbound.empty())
        {
            Inbound msg = std::move(mInbound.front());
            mInbound.pop_front();
            mInboundBytes -= std::min(mInboundBytes, msg.mData.size());
            if (msg.mIsText)
            {
                // Session tier: hand the raw JSON to Lua as a plain LSER string; scripts/mp/json.lua parses it.
                events.addGlobalEvent({ "MP_SessionJson", lserString(msg.mData) });
                continue;
            }
            // Binary envelope: [u16 type][u32 seq] LE (PROTOCOL.md).
            if (msg.mData.size() < 6)
            {
                ++mStats.mMalformed;
                continue;
            }
            const uint8_t* p = reinterpret_cast<const uint8_t*>(msg.mData.data());
            uint16_t type = readLE<uint16_t>(p);
            if (type != sTypeEvent)
            {
                ++mStats.mMalformed; // M1+ types are reserved; nothing else is valid in M0
                continue;
            }
            // Event payload: [u8 nameLen][name ASCII][body LSER].
            if (msg.mData.size() < 7)
            {
                ++mStats.mMalformed;
                continue;
            }
            size_t nameLen = p[6];
            if (nameLen == 0 || msg.mData.size() < 7 + nameLen)
            {
                ++mStats.mMalformed;
                continue;
            }
            std::string_view name(msg.mData.data() + 7, nameLen);
            bool ascii = true;
            for (char c : name)
                if (c < 0x21 || c > 0x7e)
                    ascii = false;
            if (!ascii)
            {
                ++mStats.mMalformed;
                continue;
            }
            // The body bytes are exactly LuaUtil::serialize format — deliver untouched.
            events.addGlobalEvent({ "MP_" + std::string(name), msg.mData.substr(7 + nameLen) });
        }
        if (mClosePending)
        {
            mClosePending = false;
            events.addGlobalEvent({ "MP_TransportClose", {} });
        }
    }

    void NetManager::flushOutbound()
    {
        if (!mSocket.isOpen())
            return; // keep frames queued until the socket opens (or clear on close)
        while (!mOutbound.empty())
        {
            Outbound& frame = mOutbound.front();
            bool ok = frame.mIsText ? mSocket.sendText(frame.mData)
                                    : mSocket.sendBinary(frame.mData.data(), frame.mData.size());
            if (ok)
            {
                mStats.mBytesOut += frame.mData.size();
                ++mStats.mMsgsOut;
            }
            mOutbound.pop_front();
        }
    }
}
