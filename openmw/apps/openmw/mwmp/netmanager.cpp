// Added by Virtastic (https://virtastic.app) for the OpenMW-Web port, 2026.
// See WASM_ADAPTATIONS.md at the repository root for details.
#include "netmanager.hpp"

#include <algorithm>
#include <cmath>
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

        float readF32(const uint8_t* p)
        {
            uint32_t bits = readLE<uint32_t>(p);
            float v;
            std::memcpy(&v, &bits, sizeof(v));
            return v;
        }

        void appendF32(std::string& out, float v)
        {
            uint32_t bits;
            std::memcpy(&bits, &v, sizeof(bits));
            appendLE<uint32_t>(out, bits);
        }

        // LSER fragments for the MP_MoveBatch body (serialization.cpp FORMAT_VERSION 0).
        void lserNumber(std::string& out, double v)
        {
            out.push_back(0x0); // NUMBER
            uint64_t bits;
            std::memcpy(&bits, &v, sizeof(bits));
            appendLE<uint64_t>(out, bits);
        }

        void lserShortString(std::string& out, std::string_view s)
        {
            out.push_back(static_cast<char>(0x20 | s.size())); // SHORT_STRING, size < 32
            out.append(s);
        }

        void lserKV(std::string& out, std::string_view key, double v)
        {
            lserShortString(out, key);
            lserNumber(out, v);
        }

        constexpr double sPi = 3.14159265358979323846;

        constexpr uint16_t sTypeEvent = 0x0002; // PROTOCOL.md binary type registry
        constexpr uint16_t sTypePlayerMove = 0x0100;
        constexpr uint16_t sTypePlayerMoveBatch = 0x0101;
        constexpr size_t sMovePayload = 20; // f32 x,y,z + u16 yaw + u8 pitch,flags,animVel,counter
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

    bool NetManager::sendMove(float x, float y, float z, float yaw, float pitch, uint8_t flags, float animVel)
    {
        if (!mSocket.isConnected())
            return false;
        // Quantize per PROTOCOL.md 0x0100: u16 yaw 0..65535 = 0..2pi (wraps),
        // u8 pitch 0..255 = -pi/2..+pi/2, u8 animVel 0..255 = 0..2x base walk speed.
        double yawNorm = std::fmod(static_cast<double>(yaw), 2.0 * sPi);
        if (yawNorm < 0)
            yawNorm += 2.0 * sPi;
        const uint16_t yawQ = static_cast<uint16_t>(std::lround(yawNorm / (2.0 * sPi) * 65536.0) & 0xffff);
        const double pitchC = std::clamp(static_cast<double>(pitch), -sPi / 2.0, sPi / 2.0);
        const uint8_t pitchQ = static_cast<uint8_t>(std::lround((pitchC + sPi / 2.0) / sPi * 255.0));
        const uint8_t velQ = static_cast<uint8_t>(std::clamp(std::lround(animVel * 127.5), 0L, 255L));
        std::string frame;
        frame.reserve(6 + sMovePayload);
        appendLE<uint16_t>(frame, sTypePlayerMove);
        appendLE<uint32_t>(frame, ++mSeq);
        appendF32(frame, x);
        appendF32(frame, y);
        appendF32(frame, z);
        appendLE<uint16_t>(frame, yawQ);
        frame.push_back(static_cast<char>(pitchQ));
        frame.push_back(static_cast<char>(flags));
        frame.push_back(static_cast<char>(velQ));
        frame.push_back('\0'); // counter, reserved 0 in M1
        frame.push_back('\0'); // bytes 18-19 reserved, MUST be zero (payload is exactly 20)
        frame.push_back('\0');
        mOutbound.push_back({ false, std::move(frame) });
        return true;
    }

    bool NetManager::sendJson(const std::string& json)
    {
        if (!mSocket.isConnected())
            return false;
        mOutbound.push_back({ true, json });
        // Session tier is rare and deadline-sensitive (the server drops us if Hello takes
        // >10 s): flush NOW instead of waiting for the frame pump — world-loading stalls
        // (tens of seconds on a cold boot) must not eat the Hello window. Drains the whole
        // queue, so cross-tier ordering is preserved.
        flushOutbound();
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
            if (type == sTypePlayerMoveBatch)
            {
                // 0x0101: [u8 count] then count x (u16 playerId + 20-byte PlayerMove).
                // Decoded here and delivered as ONE global event MP_MoveBatch whose body is an
                // LSER array of flat number-tables (PROTOCOL.md); yaw/pitch dequantized back to
                // radians, animVel to 0..2. Envelope-seq stale-drop for the movement family.
                const uint32_t seq = readLE<uint32_t>(p + 2);
                if (seq <= mLastMoveSeqIn)
                    continue;
                mLastMoveSeqIn = seq;
                if (msg.mData.size() < 7)
                {
                    ++mStats.mMalformed;
                    continue;
                }
                const size_t count = p[6];
                if (msg.mData.size() != 7 + count * (2 + sMovePayload))
                {
                    ++mStats.mMalformed;
                    continue;
                }
                std::string body;
                body.reserve(2 + count * 96);
                body.push_back('\0'); // FORMAT_VERSION
                body.push_back(0x3); // TABLE_START (outer array)
                for (size_t i = 0; i < count; ++i)
                {
                    const uint8_t* e = p + 7 + i * (2 + sMovePayload);
                    lserNumber(body, static_cast<double>(i + 1)); // 1-based array key
                    body.push_back(0x3); // TABLE_START (entry)
                    lserKV(body, "id", readLE<uint16_t>(e));
                    lserKV(body, "x", readF32(e + 2));
                    lserKV(body, "y", readF32(e + 6));
                    lserKV(body, "z", readF32(e + 10));
                    lserKV(body, "yaw", readLE<uint16_t>(e + 14) * (2.0 * sPi / 65536.0));
                    lserKV(body, "pitch", e[16] / 255.0 * sPi - sPi / 2.0);
                    lserKV(body, "flags", e[17]);
                    lserKV(body, "animVel", e[18] / 127.5);
                    body.push_back(0x4); // TABLE_END (entry)
                }
                body.push_back(0x4); // TABLE_END (outer)
                events.addGlobalEvent({ "MP_MoveBatch", std::move(body) });
                continue;
            }
            if (type != sTypeEvent)
            {
                ++mStats.mMalformed; // 0x0100 is C->S only; other types are reserved
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
