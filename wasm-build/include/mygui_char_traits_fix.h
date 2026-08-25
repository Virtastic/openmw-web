// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
//
// MyGUI 3.4.3's UString is std::basic_string<unsigned short>. libc++ only ever specialises
// std::char_traits for the standard character types, and newer releases removed the primary
// template it used to fall back on — so MyGUI stopped compiling ("implicit instantiation of
// undefined template char_traits<unsigned short>") on a modern toolchain.
//
// unsigned short / unsigned int are layout-identical to char16_t / char32_t here, so one
// generic implementation serves both. MyGUI's UString uses whichever the platform selects.
#pragma once
#include <string>
#include <cstring>
namespace std {
template <class T> struct omw_uint_char_traits {
  using char_type = T; using int_type = unsigned int;
  using off_type = streamoff; using pos_type = streampos; using state_type = mbstate_t;
  static void assign(char_type& a, const char_type& b) noexcept { a = b; }
  static constexpr bool eq(char_type a, char_type b) noexcept { return a == b; }
  static constexpr bool lt(char_type a, char_type b) noexcept { return a < b; }
  static int compare(const char_type* s1, const char_type* s2, size_t n) {
    for (; n; --n, ++s1, ++s2) { if (*s1 < *s2) return -1; if (*s2 < *s1) return 1; } return 0; }
  static size_t length(const char_type* s) { size_t n = 0; while (s[n]) ++n; return n; }
  static const char_type* find(const char_type* s, size_t n, const char_type& a) {
    for (; n; --n, ++s) if (*s == a) return s; return nullptr; }
  static char_type* move(char_type* d, const char_type* s, size_t n) {
    return (char_type*)memmove(d, s, n * sizeof(char_type)); }
  static char_type* copy(char_type* d, const char_type* s, size_t n) {
    return (char_type*)memcpy(d, s, n * sizeof(char_type)); }
  static char_type* assign(char_type* s, size_t n, char_type a) {
    for (size_t i = 0; i < n; ++i) s[i] = a; return s; }
  static constexpr int_type not_eof(int_type c) noexcept { return eq_int_type(c, eof()) ? 0 : c; }
  static constexpr char_type to_char_type(int_type c) noexcept { return char_type(c); }
  static constexpr int_type to_int_type(char_type c) noexcept { return int_type(c); }
  static constexpr bool eq_int_type(int_type a, int_type b) noexcept { return a == b; }
  static constexpr int_type eof() noexcept { return int_type(-1); }
};
// libc++ requires an exact specialisation, not a partial one, so name both explicitly.
template <> struct char_traits<unsigned short> : omw_uint_char_traits<unsigned short> {};
template <> struct char_traits<unsigned int>   : omw_uint_char_traits<unsigned int> {};
}
