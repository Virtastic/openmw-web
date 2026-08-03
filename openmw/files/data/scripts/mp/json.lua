-- Strict, dependency-free JSON for the omw-mp/1 session tier (server/PROTOCOL.md).
-- OpenMW Lua has no built-in JSON parser, so the transport hands session frames to Lua as
-- plain strings and this module does the (de)coding. Not a general-purpose library: it is
-- strict (rejects trailing garbage, bad escapes, unterminated values) and small on purpose.
local json = {}

-- JSON null cannot be a table key/value distinct from absence in Lua; use a sentinel.
json.null = setmetatable({}, { __tostring = function() return 'json.null' end })

local escapeMap = {
    ['"'] = '\\"', ['\\'] = '\\\\', ['\b'] = '\\b', ['\f'] = '\\f',
    ['\n'] = '\\n', ['\r'] = '\\r', ['\t'] = '\\t',
}

local function encodeString(s)
    return '"' .. s:gsub('[%z\1-\31"\\]', function(c)
        return escapeMap[c] or string.format('\\u%04x', c:byte())
    end) .. '"'
end

local function isArray(t)
    local n = 0
    for k in pairs(t) do
        if type(k) ~= 'number' or k ~= math.floor(k) or k < 1 then return false end
        if k > n then n = k end
    end
    -- dense 1..n only
    for i = 1, n do
        if t[i] == nil then return false end
    end
    return true, n
end

local function encodeValue(v, out, depth)
    if depth > 16 then error('json.encode: too deeply nested') end
    local tv = type(v)
    if v == json.null then
        out[#out + 1] = 'null'
    elseif tv == 'nil' then
        out[#out + 1] = 'null'
    elseif tv == 'boolean' then
        out[#out + 1] = v and 'true' or 'false'
    elseif tv == 'number' then
        if v ~= v or v == math.huge or v == -math.huge then
            error('json.encode: cannot encode NaN/Inf')
        end
        if v == math.floor(v) and math.abs(v) < 2^53 then
            out[#out + 1] = string.format('%d', v)
        else
            out[#out + 1] = string.format('%.17g', v)
        end
    elseif tv == 'string' then
        out[#out + 1] = encodeString(v)
    elseif tv == 'table' then
        local array, n = isArray(v)
        if array then
            out[#out + 1] = '['
            for i = 1, n do
                if i > 1 then out[#out + 1] = ',' end
                encodeValue(v[i], out, depth + 1)
            end
            out[#out + 1] = ']'
        else
            out[#out + 1] = '{'
            local first = true
            for k, val in pairs(v) do
                if type(k) ~= 'string' then error('json.encode: object keys must be strings') end
                if not first then out[#out + 1] = ',' end
                first = false
                out[#out + 1] = encodeString(k)
                out[#out + 1] = ':'
                encodeValue(val, out, depth + 1)
            end
            out[#out + 1] = '}'
        end
    else
        error('json.encode: unsupported type ' .. tv)
    end
end

function json.encode(v)
    local out = {}
    encodeValue(v, out, 0)
    return table.concat(out)
end

-- --- decoding ---

local function skipWs(s, i)
    local _, j = s:find('^[ \t\r\n]*', i)
    return j + 1
end

local decodeValue

local unescapeMap = {
    ['"'] = '"', ['\\'] = '\\', ['/'] = '/', b = '\b', f = '\f', n = '\n', r = '\r', t = '\t',
}

local function utf8Char(code)
    if code < 0x80 then
        return string.char(code)
    elseif code < 0x800 then
        return string.char(0xC0 + math.floor(code / 0x40), 0x80 + code % 0x40)
    elseif code < 0x10000 then
        return string.char(0xE0 + math.floor(code / 0x1000),
            0x80 + math.floor(code / 0x40) % 0x40, 0x80 + code % 0x40)
    else
        return string.char(0xF0 + math.floor(code / 0x40000),
            0x80 + math.floor(code / 0x1000) % 0x40,
            0x80 + math.floor(code / 0x40) % 0x40, 0x80 + code % 0x40)
    end
end

local function decodeString(s, i)
    local out, n = {}, 0
    i = i + 1 -- opening quote
    while true do
        local c = s:sub(i, i)
        if c == '' then error('json.decode: unterminated string') end
        if c == '"' then return table.concat(out), i + 1 end
        if c == '\\' then
            local esc = s:sub(i + 1, i + 1)
            if esc == 'u' then
                local hex = s:sub(i + 2, i + 5)
                if not hex:match('^%x%x%x%x$') then error('json.decode: bad \\u escape') end
                local code = tonumber(hex, 16)
                i = i + 6
                if code >= 0xD800 and code <= 0xDBFF then -- surrogate pair
                    local lo = s:sub(i, i + 5)
                    local loHex = lo:match('^\\u(%x%x%x%x)$')
                    local loCode = loHex and tonumber(loHex, 16)
                    if not loCode or loCode < 0xDC00 or loCode > 0xDFFF then
                        error('json.decode: bad surrogate pair')
                    end
                    code = 0x10000 + (code - 0xD800) * 0x400 + (loCode - 0xDC00)
                    i = i + 6
                end
                n = n + 1; out[n] = utf8Char(code)
            else
                local mapped = unescapeMap[esc]
                if not mapped then error('json.decode: bad escape \\' .. esc) end
                n = n + 1; out[n] = mapped
                i = i + 2
            end
        elseif c:byte() < 0x20 then
            error('json.decode: raw control character in string')
        else
            n = n + 1; out[n] = c
            i = i + 1
        end
    end
end

local function decodeNumber(s, i)
    local numStr = s:match('^-?%d+%.?%d*[eE]?[+%-]?%d*', i)
    local v = tonumber(numStr)
    if not v then error('json.decode: bad number at ' .. i) end
    return v, i + #numStr
end

decodeValue = function(s, i, depth)
    if depth > 16 then error('json.decode: too deeply nested') end
    i = skipWs(s, i)
    local c = s:sub(i, i)
    if c == '"' then
        return decodeString(s, i)
    elseif c == '{' then
        local obj = {}
        i = skipWs(s, i + 1)
        if s:sub(i, i) == '}' then return obj, i + 1 end
        while true do
            i = skipWs(s, i)
            if s:sub(i, i) ~= '"' then error('json.decode: expected object key at ' .. i) end
            local key; key, i = decodeString(s, i)
            i = skipWs(s, i)
            if s:sub(i, i) ~= ':' then error('json.decode: expected ":" at ' .. i) end
            local val; val, i = decodeValue(s, i + 1, depth + 1)
            obj[key] = val
            i = skipWs(s, i)
            local sep = s:sub(i, i)
            if sep == '}' then return obj, i + 1 end
            if sep ~= ',' then error('json.decode: expected "," or "}" at ' .. i) end
            i = i + 1
        end
    elseif c == '[' then
        local arr = {}
        i = skipWs(s, i + 1)
        if s:sub(i, i) == ']' then return arr, i + 1 end
        while true do
            local val; val, i = decodeValue(s, i, depth + 1)
            arr[#arr + 1] = val
            i = skipWs(s, i)
            local sep = s:sub(i, i)
            if sep == ']' then return arr, i + 1 end
            if sep ~= ',' then error('json.decode: expected "," or "]" at ' .. i) end
            i = i + 1
        end
    elseif s:sub(i, i + 3) == 'true' then
        return true, i + 4
    elseif s:sub(i, i + 4) == 'false' then
        return false, i + 5
    elseif s:sub(i, i + 3) == 'null' then
        return json.null, i + 4
    elseif c:match('[%-%d]') then
        return decodeNumber(s, i)
    end
    error('json.decode: unexpected character "' .. c .. '" at ' .. i)
end

function json.decode(s)
    if type(s) ~= 'string' then error('json.decode: expected string, got ' .. type(s)) end
    local v, i = decodeValue(s, 1, 0)
    i = skipWs(s, i)
    if i <= #s then error('json.decode: trailing garbage at ' .. i) end
    return v
end

return json
