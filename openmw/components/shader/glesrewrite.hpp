// The GLES rewriting of OpenMW's shaders without std::regex (web build only).
// adjustSourceForGLES (shadermanager.cpp) ran about 40 std::regex constructions and passes over each merged shader
// source, on the page's thread, whenever a shader variant was first asked for (a 213 ms frame measured for the rain's).
// The same rewrites as plain scans, each giving the bytes its regex gave (checked byte for byte against the regexes over every
// shader of the engine and 200,000 generated sources): `\b` is a boundary between a word character
// ([A-Za-z0-9_], the "C" locale's) and anything else, `\s` one of " \t\n\v\f\r".
#ifndef OPENMW_COMPONENTS_SHADER_GLESREWRITE_H
#define OPENMW_COMPONENTS_SHADER_GLESREWRITE_H

#include <cstddef>
#include <string>
#include <string_view>

namespace Shader::GlesRewrite
{
    inline bool isWord(char c)
    {
        return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_';
    }

    inline bool isSpace(char c)
    {
        return c == ' ' || c == '\t' || c == '\n' || c == '\v' || c == '\f' || c == '\r';
    }

    inline std::size_t skipSpace(std::string_view s, std::size_t i)
    {
        while (i < s.size() && isSpace(s[i]))
            ++i;
        return i;
    }

    /// The end of a match starting at `at` (npos: none). `boundaryBefore`: `\b` before it.
    template <class Matcher>
    std::string replaceAll(const std::string& source, std::string_view first, bool boundaryBefore, Matcher matchRest,
        std::string_view replacement, bool* found = nullptr)
    {
        std::string out;
        std::size_t copied = 0, from = 0;
        bool any = false;
        while (true)
        {
            const std::size_t at = source.find(first, from);
            if (at == std::string::npos)
                break;
            std::size_t end = std::string::npos;
            if (!boundaryBefore || at == 0 || !isWord(source[at - 1]))
                end = matchRest(std::string_view(source), at + first.size());
            if (end == std::string::npos)
            {
                from = at + 1;
                continue;
            }
            if (!any)
                out.reserve(source.size() + source.size() / 8);
            any = true;
            out.append(source, copied, at - copied);
            out.append(replacement);
            copied = from = end;
        }
        if (found)
            *found = any;
        if (!any)
            return source;
        out.append(source, copied, std::string::npos);
        return out;
    }

    /// `\bword\b` (a word of word characters) by `replacement`; `found`: whether there was one.
    inline std::string replaceWord(
        const std::string& source, std::string_view word, std::string_view replacement, bool* found = nullptr)
    {
        return replaceAll(
            source, word, true,
            [](std::string_view s, std::size_t i) { return i == s.size() || !isWord(s[i]) ? i : std::string::npos; },
            replacement, found);
    }

    inline bool hasWord(const std::string& source, std::string_view word)
    {
        for (std::size_t at = source.find(word); at != std::string::npos; at = source.find(word, at + 1))
        {
            const std::size_t end = at + word.size();
            if ((at == 0 || !isWord(source[at - 1])) && (end == source.size() || !isWord(source[end])))
                return true;
        }
        return false;
    }

    /// `\bftransform\s*\(\s*\)`
    inline std::string replaceFtransform(const std::string& source, std::string_view replacement)
    {
        return replaceAll(
            source, "ftransform", true,
            [](std::string_view s, std::size_t i) {
                i = skipSpace(s, i);
                if (i == s.size() || s[i] != '(')
                    return std::string::npos;
                i = skipSpace(s, i + 1);
                if (i == s.size() || s[i] != ')')
                    return std::string::npos;
                return i + 1;
            },
            replacement);
    }

    /// `gl_TextureMatrix\[[0-9]+\]` (no boundary before)
    inline std::string replaceTextureMatrix(const std::string& source, std::string_view replacement)
    {
        return replaceAll(
            source, "gl_TextureMatrix[", false,
            [](std::string_view s, std::size_t i) {
                const std::size_t digits = i;
                while (i < s.size() && s[i] >= '0' && s[i] <= '9')
                    ++i;
                if (i == digits || i == s.size() || s[i] != ']')
                    return std::string::npos;
                return i + 1;
            },
            replacement);
    }

    /// `\bstruct\s*\.\s*member\b` (gl_FrontMaterial.diffuse, gl_Fog . color)
    inline std::string replaceMember(
        const std::string& source, std::string_view structName, std::string_view member, std::string_view replacement)
    {
        return replaceAll(
            source, structName, true,
            [member](std::string_view s, std::size_t i) {
                i = skipSpace(s, i);
                if (i == s.size() || s[i] != '.')
                    return std::string::npos;
                i = skipSpace(s, i + 1);
                if (s.substr(i, member.size()) != member)
                    return std::string::npos;
                i += member.size();
                return i == s.size() || !isWord(s[i]) ? i : std::string::npos;
            },
            replacement);
    }

    /// A `$link` statement (what follows "$link" on its line) as the regex
    /// `\s*"([^"]+)"\s*(if\s+(!)?\s*([_a-zA-Z0-9]+)?)?\s*` matched whole: false when it does not match.
    inline bool parseLinkStatement(std::string_view s, std::string& target, bool& hasCondition, bool& negated,
        std::string& conditionExpression)
    {
        std::size_t i = skipSpace(s, 0);
        if (i == s.size() || s[i] != '"')
            return false;
        const std::size_t nameStart = ++i;
        while (i < s.size() && s[i] != '"')
            ++i;
        if (i == s.size() || i == nameStart)
            return false;
        const std::string_view name = s.substr(nameStart, i - nameStart);
        i = skipSpace(s, i + 1);
        bool condition = false, bang = false;
        std::string_view expression;
        if (s.substr(i, 2) == "if" && i + 2 < s.size() && isSpace(s[i + 2]))
        {
            condition = true;
            i = skipSpace(s, i + 2);
            if (i < s.size() && s[i] == '!')
            {
                bang = true;
                i = skipSpace(s, i + 1);
            }
            const std::size_t e = i;
            while (i < s.size() && isWord(s[i]))
                ++i;
            expression = s.substr(e, i - e);
            i = skipSpace(s, i);
        }
        if (i != s.size())
            return false;
        target = std::string(name);
        hasCondition = condition;
        negated = bang;
        conditionExpression = std::string(expression);
        return true;
    }
}

#endif
