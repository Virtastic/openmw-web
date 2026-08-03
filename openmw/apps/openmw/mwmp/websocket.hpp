// Added by Virtastic (https://virtastic.app) for the OpenMW-Web port, 2026.
// See WASM_ADAPTATIONS.md at the repository root for details.
#ifndef MWMP_WEBSOCKET_H
#define MWMP_WEBSOCKET_H

#include <cstddef>
#include <cstdint>
#include <functional>
#include <string>

namespace MWMP
{
    // Thin wrapper over the emscripten WebSocket API (-lwebsocket.js). On native builds every
    // method is a no-op so the tree still configures/compiles for desktop.
    //
    // The browser delivers WebSocket callbacks as separate main-thread tasks; the engine frame
    // is itself one synchronous main-thread task (EmscriptenLoop::tick), so callbacks can never
    // interleave with a frame — enqueue-only callbacks need no locking.
    class WebSocket
    {
    public:
        struct Callbacks
        {
            std::function<void()> mOnOpen;
            // isText: true for text (JSON control tier) frames, false for binary.
            std::function<void(const uint8_t* data, size_t size, bool isText)> mOnMessage;
            std::function<void()> mOnError;
            std::function<void(uint16_t code, std::string reason, bool wasClean)> mOnClose;
        };

        WebSocket() = default;
        ~WebSocket();
        WebSocket(const WebSocket&) = delete;
        WebSocket& operator=(const WebSocket&) = delete;

        void setCallbacks(Callbacks callbacks) { mCallbacks = std::move(callbacks); }

        // Drain queued socket events and fire callbacks — MAIN THREAD ONLY, once per frame
        // (called from NetManager::pumpInboundToLua). On emscripten this is a no-op: the
        // browser already delivers callbacks as main-thread tasks between frames. The
        // native build has a real reader thread, and NetManager's callbacks mutate its
        // state inline, so firing them from the socket thread would race the whole net
        // layer; poll() is what preserves the "callbacks never interleave with a frame"
        // invariant the emscripten path gets for free.
        void poll();

        bool open(const std::string& url, const std::string& subprotocol);
        void close(uint16_t code, const std::string& reason);
        bool sendBinary(const void* data, size_t size);
        bool sendText(const std::string& str);
        size_t bufferedAmount() const;
        bool isOpen() const { return mOpen; }
        bool isConnected() const { return mSocket != 0; }

    private:
        Callbacks mCallbacks;
        int mSocket = 0; // EMSCRIPTEN_WEBSOCKET_T (0 = none); native: 1 while connected
        bool mOpen = false;

        // Native transport state (unused on emscripten); pimpl so this header stays free of
        // <thread>/<mutex> and platform sockets.
        struct NativeState;
        NativeState* mNative = nullptr;

        friend struct WebSocketCallbackBridge;
    };
}

#endif // MWMP_WEBSOCKET_H
