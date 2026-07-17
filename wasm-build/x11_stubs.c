// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
/* X11 no-op stubs for the openmw-web build.
 *
 * osgViewer is compiled with its X11 windowing backend (OSG has no "none" backend for
 * unix-like targets), so libosgViewer.a references ~48 Xlib functions. At runtime the
 * actual window/GL context comes from SDL2 -> Emscripten -> WebGL (wrapped via
 * GraphicsWindowEmbedded), so none of these do real work — EXCEPT that OSG's
 * X11WindowingSystemInterface static constructor calls XSetErrorHandler() during
 * __wasm_call_ctors, before main().
 *
 * CRITICAL: signatures must be EXACT (hence including the sysroot X11 headers).
 * wasm-ld replaces signature-MISMATCHED definitions with unreachable-trap stubs, and
 * under -fwasm-exceptions calls are direct (no invoke_* thunks), so a mismatched
 * XSetErrorHandler traps at boot inside __wasm_call_ctors.
 *
 * Build:  emcc -O2 -c wasm-build/x11_stubs.c -o <build>/x11_stubs.o
 * (The emscripten sysroot ships the X11 headers; no extra include paths needed.)
 */
#include <X11/XKBlib.h>
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <stddef.h>

/* ---- Display / connection ---- */
Display* XOpenDisplay(const char* name)
{
    (void)name;
    return NULL;
}
int XCloseDisplay(Display* d)
{
    (void)d;
    return 0;
}
char* XDisplayName(const char* s)
{
    (void)s;
    return (char*)"";
}
int XFlush(Display* d)
{
    (void)d;
    return 0;
}
int XSync(Display* d, Bool b)
{
    (void)d;
    (void)b;
    return 0;
}
int XFree(void* p)
{
    (void)p;
    return 0;
}

/* ---- Events ---- */
int XPending(Display* d)
{
    (void)d;
    return 0;
}
int XNextEvent(Display* d, XEvent* e)
{
    (void)d;
    (void)e;
    return 0;
}
int XPeekEvent(Display* d, XEvent* e)
{
    (void)d;
    (void)e;
    return 0;
}
Bool XCheckMaskEvent(Display* d, long m, XEvent* e)
{
    (void)d;
    (void)m;
    (void)e;
    return False;
}
Status XSendEvent(Display* d, Window w, Bool p, long m, XEvent* e)
{
    (void)d;
    (void)w;
    (void)p;
    (void)m;
    (void)e;
    return 0;
}

/* ---- Error handling (called from a static ctor: signature MUST match) ---- */
XErrorHandler XSetErrorHandler(XErrorHandler h)
{
    (void)h;
    return NULL;
}
int XGetErrorText(Display* d, int code, char* buf, int len)
{
    (void)d;
    (void)code;
    if (buf && len > 0)
        buf[0] = '\0';
    return 0;
}

/* ---- Windows ---- */
Window XCreateWindow(Display* d, Window parent, int x, int y, unsigned int w, unsigned int h,
    unsigned int border, int depth, unsigned int cls, Visual* visual, unsigned long valuemask,
    XSetWindowAttributes* attrs)
{
    (void)d;
    (void)parent;
    (void)x;
    (void)y;
    (void)w;
    (void)h;
    (void)border;
    (void)depth;
    (void)cls;
    (void)visual;
    (void)valuemask;
    (void)attrs;
    return 0;
}
int XDestroyWindow(Display* d, Window w)
{
    (void)d;
    (void)w;
    return 0;
}
int XMapWindow(Display* d, Window w)
{
    (void)d;
    (void)w;
    return 0;
}
int XRaiseWindow(Display* d, Window w)
{
    (void)d;
    (void)w;
    return 0;
}
int XMoveResizeWindow(Display* d, Window w, int x, int y, unsigned int width, unsigned int height)
{
    (void)d;
    (void)w;
    (void)x;
    (void)y;
    (void)width;
    (void)height;
    return 0;
}
int XReparentWindow(Display* d, Window w, Window parent, int x, int y)
{
    (void)d;
    (void)w;
    (void)parent;
    (void)x;
    (void)y;
    return 0;
}
int XSelectInput(Display* d, Window w, long mask)
{
    (void)d;
    (void)w;
    (void)mask;
    return 0;
}
int XStoreName(Display* d, Window w, const char* name)
{
    (void)d;
    (void)w;
    (void)name;
    return 0;
}
int XSetIconName(Display* d, Window w, const char* name)
{
    (void)d;
    (void)w;
    (void)name;
    return 0;
}
int XSetInputFocus(Display* d, Window w, int revert_to, Time t)
{
    (void)d;
    (void)w;
    (void)revert_to;
    (void)t;
    return 0;
}
int XSetStandardProperties(Display* d, Window w, const char* wname, const char* iname, Pixmap icon,
    char** argv, int argc, XSizeHints* hints)
{
    (void)d;
    (void)w;
    (void)wname;
    (void)iname;
    (void)icon;
    (void)argv;
    (void)argc;
    (void)hints;
    return 0;
}
Status XSetWMProtocols(Display* d, Window w, Atom* protocols, int count)
{
    (void)d;
    (void)w;
    (void)protocols;
    (void)count;
    return 0;
}
int XSetClassHint(Display* d, Window w, XClassHint* hint)
{
    (void)d;
    (void)w;
    (void)hint;
    return 0;
}
Status XGetWMName(Display* d, Window w, XTextProperty* prop)
{
    (void)d;
    (void)w;
    (void)prop;
    return 0;
}
Status XGetWindowAttributes(Display* d, Window w, XWindowAttributes* attrs)
{
    (void)d;
    (void)w;
    (void)attrs;
    return 0;
}
int XChangeProperty(Display* d, Window w, Atom prop, Atom type, int format, int mode,
    const unsigned char* data, int nelements)
{
    (void)d;
    (void)w;
    (void)prop;
    (void)type;
    (void)format;
    (void)mode;
    (void)data;
    (void)nelements;
    return 0;
}
Atom XInternAtom(Display* d, const char* name, Bool only_if_exists)
{
    (void)d;
    (void)name;
    (void)only_if_exists;
    return 0;
}
Bool XTranslateCoordinates(Display* d, Window src, Window dst, int sx, int sy, int* dx, int* dy,
    Window* child)
{
    (void)d;
    (void)src;
    (void)dst;
    (void)sx;
    (void)sy;
    if (dx)
        *dx = 0;
    if (dy)
        *dy = 0;
    if (child)
        *child = 0;
    return False;
}
Bool XQueryPointer(Display* d, Window w, Window* root, Window* child, int* rx, int* ry, int* wx,
    int* wy, unsigned int* mask)
{
    (void)d;
    (void)w;
    if (root)
        *root = 0;
    if (child)
        *child = 0;
    if (rx)
        *rx = 0;
    if (ry)
        *ry = 0;
    if (wx)
        *wx = 0;
    if (wy)
        *wy = 0;
    if (mask)
        *mask = 0;
    return False;
}
Status XQueryTree(
    Display* d, Window w, Window* root, Window* parent, Window** children, unsigned int* n)
{
    (void)d;
    (void)w;
    if (root)
        *root = 0;
    if (parent)
        *parent = 0;
    if (children)
        *children = NULL;
    if (n)
        *n = 0;
    return 0;
}

/* ---- Keyboard ---- */
int XQueryKeymap(Display* d, char keys[32])
{
    (void)d;
    (void)keys;
    return 0;
}
int XWarpPointer(Display* d, Window src, Window dst, int sx, int sy, unsigned int sw,
    unsigned int sh, int dx, int dy)
{
    (void)d;
    (void)src;
    (void)dst;
    (void)sx;
    (void)sy;
    (void)sw;
    (void)sh;
    (void)dx;
    (void)dy;
    return 0;
}
int XLookupString(XKeyEvent* ev, char* buf, int len, KeySym* sym, XComposeStatus* status)
{
    (void)ev;
    (void)buf;
    (void)len;
    if (sym)
        *sym = 0;
    (void)status;
    return 0;
}
KeyCode XKeysymToKeycode(Display* d, KeySym sym)
{
    (void)d;
    (void)sym;
    return 0;
}
XModifierKeymap* XGetModifierMapping(Display* d)
{
    (void)d;
    return NULL;
}
KeySym XkbKeycodeToKeysym(Display* d, KeyCode kc, int group, int level)
{
    (void)d;
    (void)kc;
    (void)group;
    (void)level;
    return 0;
}

/* ---- Visuals / colormaps / cursors ---- */
XVisualInfo* XGetVisualInfo(Display* d, long mask, XVisualInfo* tmpl, int* n)
{
    (void)d;
    (void)mask;
    (void)tmpl;
    if (n)
        *n = 0;
    return NULL;
}
Status XMatchVisualInfo(Display* d, int screen, int depth, int cls, XVisualInfo* out)
{
    (void)d;
    (void)screen;
    (void)depth;
    (void)cls;
    (void)out;
    return 0;
}
VisualID XVisualIDFromVisual(Visual* v)
{
    (void)v;
    return 0;
}
Colormap XCreateColormap(Display* d, Window w, Visual* v, int alloc)
{
    (void)d;
    (void)w;
    (void)v;
    (void)alloc;
    return 0;
}
Cursor XCreateFontCursor(Display* d, unsigned int shape)
{
    (void)d;
    (void)shape;
    return 0;
}
Cursor XCreatePixmapCursor(Display* d, Pixmap src, Pixmap mask, XColor* fg, XColor* bg,
    unsigned int x, unsigned int y)
{
    (void)d;
    (void)src;
    (void)mask;
    (void)fg;
    (void)bg;
    (void)x;
    (void)y;
    return 0;
}
Pixmap XCreateBitmapFromData(
    Display* d, Drawable dr, const char* data, unsigned int w, unsigned int h)
{
    (void)d;
    (void)dr;
    (void)data;
    (void)w;
    (void)h;
    return 0;
}
int XFreePixmap(Display* d, Pixmap p)
{
    (void)d;
    (void)p;
    return 0;
}
int XDefineCursor(Display* d, Window w, Cursor c)
{
    (void)d;
    (void)w;
    (void)c;
    return 0;
}
