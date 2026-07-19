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

#else // !__EMSCRIPTEN__ — native no-op stubs so the tree still configures for desktop.

namespace MWMP
{
    WebSocket::~WebSocket() = default;

    bool WebSocket::open(const std::string&, const std::string&)
    {
        return false;
    }

    void WebSocket::close(uint16_t, const std::string&) {}

    bool WebSocket::sendBinary(const void*, size_t)
    {
        return false;
    }

    bool WebSocket::sendText(const std::string&)
    {
        return false;
    }

    size_t WebSocket::bufferedAmount() const
    {
        return 0;
    }
}

#endif
