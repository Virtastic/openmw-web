// Added by Virtastic (https://virtastic.app) for the OpenMW-Web port, 2026.
// See WASM_ADAPTATIONS.md at the repository root for details.
#ifndef MWMP_NETMANAGER_H
#define MWMP_NETMANAGER_H

#include <cstdint>
#include <deque>
#include <string>
#include <string_view>

#include "websocket.hpp"

namespace MWLua
{
    class LuaEvents;
}

namespace MWMP
{
    // Client transport for the omw-mp/1 wire protocol (see server/PROTOCOL.md — M0).
    //
    // Owns the WebSocket and the inbound/outbound frame queues. WS callbacks ONLY enqueue;
    // LuaManager::update() drains inbound into Lua global events (pumpInboundToLua, called
    // before LuaEvents::finalizeEventBatch so frames are delivered the same frame) and drains
    // outbound at the end of the frame (flushOutbound). Single-threaded by construction on web.
    //
    // Session-tier state transitions (HelloSent/Authing/Joined) are driven by the Lua side
    // (scripts/mp/net.lua); NetManager only tracks what it is told plus raw connection state.
    class NetManager
    {
    public:
        enum class State
        {
            Offline,
            Connecting,
            HelloSent,
            Authing,
            Joined,
            Failed,
        };

        struct Stats
        {
            uint64_t mBytesIn = 0;
            uint64_t mBytesOut = 0;
            uint64_t mMsgsIn = 0;
            uint64_t mMsgsOut = 0;
            uint64_t mDroppedInbound = 0; // dropped because the pending queue exceeded the cap
            uint64_t mMalformed = 0; // bad envelope / unknown type / bad name
        };

        static NetManager& instance();

        // Opens the socket with subprotocol "omw-mp/1" (PROTOCOL.md Transport). State -> Connecting.
        bool connect(const std::string& url);
        void disconnect();

        // Lua-driven session-tier transitions (only the states listed above are accepted).
        void setSessionState(std::string_view name);
        std::string_view stateName() const;
        State state() const { return mState; }

        // Event tier: builds [u16 0x0002][u32 seq][u8 nameLen][name][LSER body] (PROTOCOL.md).
        // `lserBody` must already be LuaUtil::serialize output. Returns false if not connected.
        bool sendEvent(std::string_view name, const std::string& lserBody);
        // Movement tier (M1): quantizes+packs one 0x0100 PlayerMove (20-byte payload).
        // yaw/pitch in radians, animVel in 0..2 (x base walk speed). Runs at ~15 Hz.
        bool sendMove(float x, float y, float z, float yaw, float pitch, uint8_t flags, float animVel);
        // Session tier: one JSON object per text frame.
        bool sendJson(const std::string& json);

        // Drains the inbound queue into Lua global events:
        //   binary Event 0x0002        -> "MP_<name>" with the raw LSER body
        //   text (session JSON)        -> "MP_SessionJson" with the JSON as an LSER string
        //   socket opened              -> "MP_TransportOpen" (empty body)
        //   socket closed/error        -> "MP_TransportClose" (empty body; details via status())
        void pumpInboundToLua(MWLua::LuaEvents& events);

        // Drains the outbound queue into WS sends (1:1 frame:message for M0).
        void flushOutbound();

        const Stats& stats() const { return mStats; }
        size_t bufferedAmount() const { return mSocket.bufferedAmount(); }
        uint16_t lastCloseCode() const { return mCloseCode; }
        const std::string& lastCloseReason() const { return mCloseReason; }

    private:
        NetManager() = default;

        void onMessage(const uint8_t* data, size_t size, bool isText);
        void onClose(uint16_t code, std::string reason);

        struct Inbound
        {
            bool mIsText;
            std::string mData;
        };
        struct Outbound
        {
            bool mIsText;
            std::string mData;
        };

        static constexpr size_t sInboundCap = 4 * 1024 * 1024; // bytes pending before dropping

        WebSocket mSocket;
        State mState = State::Offline;
        std::deque<Inbound> mInbound;
        size_t mInboundBytes = 0;
        std::deque<Outbound> mOutbound;
        uint32_t mSeq = 0; // per-sender, monotonic from 1 (PROTOCOL.md)
        uint32_t mLastMoveSeqIn = 0; // stale-drop for the movement family (PROTOCOL.md seq rule)
        bool mOpenPending = false;
        bool mClosePending = false;
        bool mSocketDead = false; // close event seen; handle reaped lazily on the next connect()
        uint16_t mCloseCode = 0;
        std::string mCloseReason;
        Stats mStats;
    };
}

#endif // MWMP_NETMANAGER_H
