// Modified by Virtastic (https://virtastic.app) for the OpenMW-Web port, 2025-2026.
// See WASM_ADAPTATIONS.md at the repository root for details of the changes.
#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstring>
#include <memory>
#include <string_view>
#include <thread>
#include <vector>

#include <cstdint>

#include <components/debug/debuglog.hpp>
#include <components/misc/constants.hpp>
#include <components/misc/resourcehelpers.hpp>
#include <components/misc/thread.hpp>
#include <components/settings/values.hpp>
#include <components/vfs/manager.hpp>

#include "efxpresets.h"
#include "loudness.hpp"
#include "openaloutput.hpp"
#include "sound.hpp"
#include "sounddecoder.hpp"
#include "soundmanagerimp.hpp"

#ifdef __EMSCRIPTEN__
#include <emscripten.h>

// ---------------------------------------------------------------------------
// EFX over Web Audio.
//
// Emscripten's OpenAL (a Web Audio reimplementation) has no ALC_EXT_EFX, so on
// desktop-parity features OpenMW falls back to crude gain/pitch tricks. Web Audio
// has the primitives natively, and EM_JS code is emitted into the same JS module
// scope as emscripten's `AL` library object, so we can reach each source's node
// graph (src.gain -> [src.panner] -> ctx.gain) directly:
//   - AL_FILTER_LOWPASS  -> a BiquadFilterNode inserted after the source gain
//                           (underwater/muffled sounds).
//   - AL_EFFECT_EAXREVERB + aux slot -> a ConvolverNode with an impulse response
//     synthesized from the reverb parameters (RT60 = decay time), fed by
//     per-source send connections (interior/underwater reverb).
// The function-pointer surface OpenMW loads via alGetProcAddress is provided by
// the EfxShim adapters below (LOAD_FUNC is redirected under __EMSCRIPTEN__).
// ---------------------------------------------------------------------------

// clang-format off
EM_JS(void, omw_efx_setup, (), {
    if (Module.__EFX) return;
    Module.__EFX = { nextId: 1, filters: {}, effects: {}, slots: {}, src: {} };
    // Bind effect -> slot: (re)build the convolver + impulse response from reverb params.
    Module.__efxBind = function(slot, effect) {
        var E = Module.__EFX;
        var s = E.slots[slot]; if (!s) return;
        s.effect = effect;
        var AL_ = (typeof AL !== 'undefined') ? AL : null;
        if (!AL_ || !AL_.currentCtx) return;
        var actx = AL_.currentCtx.audioCtx;
        if (!s.conv) {
            s.conv = actx.createConvolver();
            s.wet = actx.createGain();
            s.conv.connect(s.wet);
            s.wet.connect(AL_.currentCtx.gain);
        }
        var fx = E.effects[effect];
        if (!fx) { s.wet.gain.value = 0; return; }
        // Impulse response: stereo decaying noise; RT60 = decayTime, HF damping from
        // decayHFRatio via a one-pole lowpass over the noise.
        var dur = Math.min(Math.max(fx.decayTime || 1.5, 0.2), 8);
        var rate = actx.sampleRate, len = Math.max(1, Math.floor(dur * rate));
        var buf = actx.createBuffer(2, len, rate);
        var hf = Math.min(Math.max(fx.decayHFRatio || 0.8, 0.1), 2.0);
        var alpha = Math.min(0.95, Math.max(0.05, 1.2 - hf)); // lower ratio -> darker tail
        for (var ch = 0; ch < 2; ch++) {
            var d = buf.getChannelData(ch), lp = 0;
            for (var i = 0; i < len; i++) {
                var t = i / rate;
                var noise = Math.random() * 2 - 1;
                lp = lp + alpha * (noise - lp);
                d[i] = lp * Math.exp(-6.9078 * t / dur); // -60 dB at RT60
            }
        }
        s.conv.buffer = buf;
        s.wet.gain.value = Math.min(1, (fx.gain || 0) * (fx.lateGain || 1));
        fx.dirty = 0;
    };
});

EM_JS(int, omw_efx_gen, (int kind), {
    var E = Module.__EFX; var id = E.nextId++;
    if (kind === 0) E.filters[id] = { type: 0, gain: 1, gainhf: 1 };
    else if (kind === 1) E.effects[id] = { type: 0, gain: 0, gainhf: 0.89, decayTime: 1.49, decayHFRatio: 0.83, lateGain: 1.26 };
    else E.slots[id] = { effect: 0, conv: null, wet: null };
    return id;
});

EM_JS(void, omw_efx_del, (int kind, int id), {
    var E = Module.__EFX;
    if (kind === 0) delete E.filters[id];
    else if (kind === 1) delete E.effects[id];
    else { var s = E.slots[id]; if (s && s.conv) { try { s.conv.disconnect(); s.wet.disconnect(); } catch(e){} } delete E.slots[id]; }
});

EM_JS(int, omw_efx_is, (int kind, int id), {
    var E = Module.__EFX;
    return ((kind === 0 ? E.filters : kind === 1 ? E.effects : E.slots)[id]) ? 1 : 0;
});

// param maps: filters: 0x8001=AL_FILTER_TYPE, 1=AL_LOWPASS_GAIN, 2=AL_LOWPASS_GAINHF.
// effects (EAXREVERB): 0x8001=AL_EFFECT_TYPE, 3=GAIN, 4=GAINHF, 6=DECAY_TIME,
//                      7=DECAY_HFRATIO, 0xC=LATE_REVERB_GAIN (others ignored).
EM_JS(void, omw_efx_param, (int kind, int id, int param, double value), {
    var E = Module.__EFX;
    if (kind === 0) {
        var f = E.filters[id]; if (!f) return;
        if (param === 0x8001) f.type = value|0;
        else if (param === 1) f.gain = value;
        else if (param === 2) f.gainhf = value;
        // live-update any sources currently using this filter
        for (var sid in E.src) {
            var st = E.src[sid];
            if (st.filterId === id && st.biquad) {
                st.biquad.frequency.value = Math.max(200, 22050 * f.gainhf * f.gainhf);
                st.fgain.gain.value = f.gain;
            }
        }
    } else if (kind === 1) {
        var fx = E.effects[id]; if (!fx) return;
        if (param === 0x8001) fx.type = value|0;
        else if (param === 3) fx.gain = value;
        else if (param === 4) fx.gainhf = value;
        else if (param === 6) fx.decayTime = value;
        else if (param === 7) fx.decayHFRatio = value;
        else if (param === 0xC) fx.lateGain = value;
        fx.dirty = 1;
        // if a slot is bound to this effect, refresh it
        for (var slid in E.slots) if (E.slots[slid].effect === id) Module.__efxBind(slid|0, id);
    }
});

EM_JS(int, omw_efx_geti, (int kind, int id, int param), {
    var E = Module.__EFX;
    var o = (kind === 0 ? E.filters : kind === 1 ? E.effects : E.slots)[id];
    if (!o) return 0;
    if (param === 0x8001) return o.type|0;
    return 0;
});

// Bind effect -> slot (implementation lives in omw_efx_setup's Module.__efxBind).
EM_JS(void, omw_efx_slot_effect, (int slot, int effect), {
    if (Module.__efxBind) Module.__efxBind(slot, effect);
});

// Insert/remove the per-source direct lowpass: src.gain -> biquad -> fgain -> dest.
EM_JS(void, omw_efx_source_direct, (int srcId, int filterId), {
    try {
        var E = Module.__EFX;
        var AL_ = (typeof AL !== 'undefined') ? AL : null;
        if (!AL_ || !AL_.currentCtx) return;
        var s = AL_.currentCtx.sources[srcId]; if (!s) return;
        var st = E.src[srcId] || (E.src[srcId] = {});
        var dest = s.panner || AL_.currentCtx.gain;
        var f = filterId ? E.filters[filterId] : null;
        if (f && f.type === 1 /*AL_FILTER_LOWPASS*/) {
            var actx = AL_.currentCtx.audioCtx;
            if (!st.biquad) {
                st.biquad = actx.createBiquadFilter();
                st.biquad.type = 'lowpass';
                st.fgain = actx.createGain();
                st.biquad.connect(st.fgain);
            }
            st.filterId = filterId;
            st.biquad.frequency.value = Math.max(200, 22050 * f.gainhf * f.gainhf);
            st.fgain.gain.value = f.gain;
            try { s.gain.disconnect(dest); } catch(e){}
            try { st.fgain.disconnect(); } catch(e){}
            s.gain.connect(st.biquad);
            st.fgain.connect(dest);
        } else if (st.biquad) {
            st.filterId = 0;
            try { s.gain.disconnect(st.biquad); } catch(e){}
            try { st.fgain.disconnect(); } catch(e){}
            try { s.gain.connect(dest); } catch(e){}
        }
    } catch(e){}
});

// Add/remove the per-source reverb send (src.gain -> slot convolver).
EM_JS(void, omw_efx_source_send, (int srcId, int slotId, int filterId), {
    try {
        var E = Module.__EFX;
        var AL_ = (typeof AL !== 'undefined') ? AL : null;
        if (!AL_ || !AL_.currentCtx) return;
        var s = AL_.currentCtx.sources[srcId]; if (!s) return;
        var st = E.src[srcId] || (E.src[srcId] = {});
        if (st.sendSlot && E.slots[st.sendSlot] && E.slots[st.sendSlot].conv) {
            try { s.gain.disconnect(E.slots[st.sendSlot].conv); } catch(e){}
            st.sendSlot = 0;
        }
        var slot = slotId ? E.slots[slotId] : null;
        if (slot) {
            if (!slot.conv) Module.__efxBind(slotId, slot.effect | 0);
            if (slot.conv) { s.gain.connect(slot.conv); st.sendSlot = slotId; }
        }
    } catch(e){}
});
// clang-format on

namespace EfxShim
{
    void AL_APIENTRY alGenEffects(ALsizei n, ALuint* ids)
    {
        for (ALsizei i = 0; i < n; ++i)
            ids[i] = omw_efx_gen(1);
    }
    void AL_APIENTRY alDeleteEffects(ALsizei n, const ALuint* ids)
    {
        for (ALsizei i = 0; i < n; ++i)
            omw_efx_del(1, ids[i]);
    }
    ALboolean AL_APIENTRY alIsEffect(ALuint id)
    {
        return omw_efx_is(1, id) ? AL_TRUE : AL_FALSE;
    }
    void AL_APIENTRY alEffecti(ALuint id, ALenum p, ALint v)
    {
        omw_efx_param(1, id, p, v);
    }
    void AL_APIENTRY alEffectiv(ALuint id, ALenum p, const ALint* v)
    {
        omw_efx_param(1, id, p, v[0]);
    }
    void AL_APIENTRY alEffectf(ALuint id, ALenum p, ALfloat v)
    {
        omw_efx_param(1, id, p, v);
    }
    void AL_APIENTRY alEffectfv(ALuint id, ALenum p, const ALfloat* v)
    {
        omw_efx_param(1, id, p, v[0]);
    }
    void AL_APIENTRY alGetEffecti(ALuint id, ALenum p, ALint* out)
    {
        *out = omw_efx_geti(1, id, p);
    }
    void AL_APIENTRY alGetEffectiv(ALuint id, ALenum p, ALint* out)
    {
        *out = omw_efx_geti(1, id, p);
    }
    void AL_APIENTRY alGetEffectf(ALuint, ALenum, ALfloat* out)
    {
        *out = 0.0f;
    }
    void AL_APIENTRY alGetEffectfv(ALuint, ALenum, ALfloat* out)
    {
        *out = 0.0f;
    }

    void AL_APIENTRY alGenFilters(ALsizei n, ALuint* ids)
    {
        for (ALsizei i = 0; i < n; ++i)
            ids[i] = omw_efx_gen(0);
    }
    void AL_APIENTRY alDeleteFilters(ALsizei n, const ALuint* ids)
    {
        for (ALsizei i = 0; i < n; ++i)
            omw_efx_del(0, ids[i]);
    }
    ALboolean AL_APIENTRY alIsFilter(ALuint id)
    {
        return omw_efx_is(0, id) ? AL_TRUE : AL_FALSE;
    }
    void AL_APIENTRY alFilteri(ALuint id, ALenum p, ALint v)
    {
        omw_efx_param(0, id, p, v);
    }
    void AL_APIENTRY alFilteriv(ALuint id, ALenum p, const ALint* v)
    {
        omw_efx_param(0, id, p, v[0]);
    }
    void AL_APIENTRY alFilterf(ALuint id, ALenum p, ALfloat v)
    {
        omw_efx_param(0, id, p, v);
    }
    void AL_APIENTRY alFilterfv(ALuint id, ALenum p, const ALfloat* v)
    {
        omw_efx_param(0, id, p, v[0]);
    }
    void AL_APIENTRY alGetFilteri(ALuint id, ALenum p, ALint* out)
    {
        *out = omw_efx_geti(0, id, p);
    }
    void AL_APIENTRY alGetFilteriv(ALuint id, ALenum p, ALint* out)
    {
        *out = omw_efx_geti(0, id, p);
    }
    void AL_APIENTRY alGetFilterf(ALuint, ALenum, ALfloat* out)
    {
        *out = 0.0f;
    }
    void AL_APIENTRY alGetFilterfv(ALuint, ALenum, ALfloat* out)
    {
        *out = 0.0f;
    }

    void AL_APIENTRY alGenAuxiliaryEffectSlots(ALsizei n, ALuint* ids)
    {
        for (ALsizei i = 0; i < n; ++i)
            ids[i] = omw_efx_gen(2);
    }
    void AL_APIENTRY alDeleteAuxiliaryEffectSlots(ALsizei n, const ALuint* ids)
    {
        for (ALsizei i = 0; i < n; ++i)
            omw_efx_del(2, ids[i]);
    }
    ALboolean AL_APIENTRY alIsAuxiliaryEffectSlot(ALuint id)
    {
        return omw_efx_is(2, id) ? AL_TRUE : AL_FALSE;
    }
    void AL_APIENTRY alAuxiliaryEffectSloti(ALuint slot, ALenum p, ALint v)
    {
        if (p == 0x0001 /*AL_EFFECTSLOT_EFFECT*/)
            omw_efx_slot_effect(slot, v);
    }
    void AL_APIENTRY alAuxiliaryEffectSlotiv(ALuint slot, ALenum p, const ALint* v)
    {
        alAuxiliaryEffectSloti(slot, p, v[0]);
    }
    void AL_APIENTRY alAuxiliaryEffectSlotf(ALuint, ALenum, ALfloat) {}
    void AL_APIENTRY alAuxiliaryEffectSlotfv(ALuint, ALenum, const ALfloat*) {}
    void AL_APIENTRY alGetAuxiliaryEffectSloti(ALuint id, ALenum p, ALint* out)
    {
        *out = omw_efx_geti(2, id, p);
    }
    void AL_APIENTRY alGetAuxiliaryEffectSlotiv(ALuint id, ALenum p, ALint* out)
    {
        *out = omw_efx_geti(2, id, p);
    }
    void AL_APIENTRY alGetAuxiliaryEffectSlotf(ALuint, ALenum, ALfloat* out)
    {
        *out = 0.0f;
    }
    void AL_APIENTRY alGetAuxiliaryEffectSlotfv(ALuint, ALenum, ALfloat* out)
    {
        *out = 0.0f;
    }
}
#endif // __EMSCRIPTEN__

#ifndef ALC_ALL_DEVICES_SPECIFIER
#define ALC_ALL_DEVICES_SPECIFIER 0x1013
#endif

#define MAKE_PTRID(id) ((void*)(uintptr_t)id)
#define GET_PTRID(ptr) ((ALuint)(uintptr_t)ptr)

namespace
{

    const float sLoudnessFPS = 20.0f; // loudness values per second of audio

    ALCenum checkALCError(ALCdevice* device, const char* func, int line)
    {
        ALCenum err = alcGetError(device);
        if (err != ALC_NO_ERROR)
            Log(Debug::Error) << "ALC error " << alcGetString(device, err) << " (" << err << ") @ " << func << ":"
                              << line;
        return err;
    }
#define getALCError(d) checkALCError((d), __FUNCTION__, __LINE__)

    ALenum checkALError(const char* func, int line)
    {
        ALenum err = alGetError();
        if (err != AL_NO_ERROR)
            Log(Debug::Error) << "AL error " << alGetString(err) << " (" << err << ") @ " << func << ":" << line;
        return err;
    }
#define getALError() checkALError(__FUNCTION__, __LINE__)

    // Helper to get an OpenAL extension function
    template <typename T, typename R>
    void convertPointer(T& dest, R src)
    {
        memcpy(&dest, &src, sizeof(src));
    }

    template <typename T>
    void getALCFunc(T& func, ALCdevice* device, const char* name)
    {
        void* funcPtr = alcGetProcAddress(device, name);
        convertPointer(func, funcPtr);
    }

    template <typename T>
    void getALFunc(T& func, const char* name)
    {
        void* funcPtr = alGetProcAddress(name);
        convertPointer(func, funcPtr);
    }

    // Route the per-source EFX state through the Web Audio shim under emscripten
    // (emscripten's alSourcei/alSource3i don't know the EFX enums and would just
    // raise AL_INVALID_ENUM).
    inline void omwSetSourceDirectFilter(ALuint source, ALint filter)
    {
#ifdef __EMSCRIPTEN__
        omw_efx_source_direct(source, filter);
#else
        omwSetSourceDirectFilter(source, filter);
#endif
    }
    inline void omwSetSourceSendFilter(ALuint source, ALuint slot, ALint filter)
    {
#ifdef __EMSCRIPTEN__
        omw_efx_source_send(source, slot, filter);
#else
        omwSetSourceSendFilter(source, slot, filter);
#endif
    }

    // Effect objects
    LPALGENEFFECTS alGenEffects;
    LPALDELETEEFFECTS alDeleteEffects;
    LPALISEFFECT alIsEffect;
    LPALEFFECTI alEffecti;
    LPALEFFECTIV alEffectiv;
    LPALEFFECTF alEffectf;
    LPALEFFECTFV alEffectfv;
    LPALGETEFFECTI alGetEffecti;
    LPALGETEFFECTIV alGetEffectiv;
    LPALGETEFFECTF alGetEffectf;
    LPALGETEFFECTFV alGetEffectfv;
    // Filter objects
    LPALGENFILTERS alGenFilters;
    LPALDELETEFILTERS alDeleteFilters;
    LPALISFILTER alIsFilter;
    LPALFILTERI alFilteri;
    LPALFILTERIV alFilteriv;
    LPALFILTERF alFilterf;
    LPALFILTERFV alFilterfv;
    LPALGETFILTERI alGetFilteri;
    LPALGETFILTERIV alGetFilteriv;
    LPALGETFILTERF alGetFilterf;
    LPALGETFILTERFV alGetFilterfv;
    // Auxiliary slot objects
    LPALGENAUXILIARYEFFECTSLOTS alGenAuxiliaryEffectSlots;
    LPALDELETEAUXILIARYEFFECTSLOTS alDeleteAuxiliaryEffectSlots;
    LPALISAUXILIARYEFFECTSLOT alIsAuxiliaryEffectSlot;
    LPALAUXILIARYEFFECTSLOTI alAuxiliaryEffectSloti;
    LPALAUXILIARYEFFECTSLOTIV alAuxiliaryEffectSlotiv;
    LPALAUXILIARYEFFECTSLOTF alAuxiliaryEffectSlotf;
    LPALAUXILIARYEFFECTSLOTFV alAuxiliaryEffectSlotfv;
    LPALGETAUXILIARYEFFECTSLOTI alGetAuxiliaryEffectSloti;
    LPALGETAUXILIARYEFFECTSLOTIV alGetAuxiliaryEffectSlotiv;
    LPALGETAUXILIARYEFFECTSLOTF alGetAuxiliaryEffectSlotf;
    LPALGETAUXILIARYEFFECTSLOTFV alGetAuxiliaryEffectSlotfv;

    LPALEVENTCONTROLSOFT alEventControlSOFT;
    LPALEVENTCALLBACKSOFT alEventCallbackSOFT;
    LPALCREOPENDEVICESOFT alcReopenDeviceSOFT;

    void LoadEffect(ALuint effect, const EFXEAXREVERBPROPERTIES& props)
    {
        ALint type = AL_NONE;
        alGetEffecti(effect, AL_EFFECT_TYPE, &type);
        if (type == AL_EFFECT_EAXREVERB)
        {
            alEffectf(effect, AL_EAXREVERB_DIFFUSION, props.flDiffusion);
            alEffectf(effect, AL_EAXREVERB_DENSITY, props.flDensity);
            alEffectf(effect, AL_EAXREVERB_GAIN, props.flGain);
            alEffectf(effect, AL_EAXREVERB_GAINHF, props.flGainHF);
            alEffectf(effect, AL_EAXREVERB_GAINLF, props.flGainLF);
            alEffectf(effect, AL_EAXREVERB_DECAY_TIME, props.flDecayTime);
            alEffectf(effect, AL_EAXREVERB_DECAY_HFRATIO, props.flDecayHFRatio);
            alEffectf(effect, AL_EAXREVERB_DECAY_LFRATIO, props.flDecayLFRatio);
            alEffectf(effect, AL_EAXREVERB_REFLECTIONS_GAIN, props.flReflectionsGain);
            alEffectf(effect, AL_EAXREVERB_REFLECTIONS_DELAY, props.flReflectionsDelay);
            alEffectfv(effect, AL_EAXREVERB_REFLECTIONS_PAN, props.flReflectionsPan);
            alEffectf(effect, AL_EAXREVERB_LATE_REVERB_GAIN, props.flLateReverbGain);
            alEffectf(effect, AL_EAXREVERB_LATE_REVERB_DELAY, props.flLateReverbDelay);
            alEffectfv(effect, AL_EAXREVERB_LATE_REVERB_PAN, props.flLateReverbPan);
            alEffectf(effect, AL_EAXREVERB_ECHO_TIME, props.flEchoTime);
            alEffectf(effect, AL_EAXREVERB_ECHO_DEPTH, props.flEchoDepth);
            alEffectf(effect, AL_EAXREVERB_MODULATION_TIME, props.flModulationTime);
            alEffectf(effect, AL_EAXREVERB_MODULATION_DEPTH, props.flModulationDepth);
            alEffectf(effect, AL_EAXREVERB_AIR_ABSORPTION_GAINHF, props.flAirAbsorptionGainHF);
            alEffectf(effect, AL_EAXREVERB_HFREFERENCE, props.flHFReference);
            alEffectf(effect, AL_EAXREVERB_LFREFERENCE, props.flLFReference);
            alEffectf(effect, AL_EAXREVERB_ROOM_ROLLOFF_FACTOR, props.flRoomRolloffFactor);
            alEffecti(effect, AL_EAXREVERB_DECAY_HFLIMIT, props.iDecayHFLimit ? AL_TRUE : AL_FALSE);
        }
        else if (type == AL_EFFECT_REVERB)
        {
            alEffectf(effect, AL_REVERB_DIFFUSION, props.flDiffusion);
            alEffectf(effect, AL_REVERB_DENSITY, props.flDensity);
            alEffectf(effect, AL_REVERB_GAIN, props.flGain);
            alEffectf(effect, AL_REVERB_GAINHF, props.flGainHF);
            alEffectf(effect, AL_REVERB_DECAY_TIME, props.flDecayTime);
            alEffectf(effect, AL_REVERB_DECAY_HFRATIO, props.flDecayHFRatio);
            alEffectf(effect, AL_REVERB_REFLECTIONS_GAIN, props.flReflectionsGain);
            alEffectf(effect, AL_REVERB_REFLECTIONS_DELAY, props.flReflectionsDelay);
            alEffectf(effect, AL_REVERB_LATE_REVERB_GAIN, props.flLateReverbGain);
            alEffectf(effect, AL_REVERB_LATE_REVERB_DELAY, props.flLateReverbDelay);
            alEffectf(effect, AL_REVERB_AIR_ABSORPTION_GAINHF, props.flAirAbsorptionGainHF);
            alEffectf(effect, AL_REVERB_ROOM_ROLLOFF_FACTOR, props.flRoomRolloffFactor);
            alEffecti(effect, AL_REVERB_DECAY_HFLIMIT, props.iDecayHFLimit ? AL_TRUE : AL_FALSE);
        }
        getALError();
    }

    std::basic_string_view<ALCchar> getDeviceName(ALCdevice* device)
    {
        const ALCchar* name = nullptr;
        if (alcIsExtensionPresent(device, "ALC_ENUMERATE_ALL_EXT"))
            name = alcGetString(device, ALC_ALL_DEVICES_SPECIFIER);
        if (alcGetError(device) != AL_NO_ERROR || !name)
            name = alcGetString(device, ALC_DEVICE_SPECIFIER);
        if (name == nullptr) // Prevent assigning nullptr to std::string
            return {};
        return name;
    }
}

namespace MWSound
{

    static ALenum getALFormat(ChannelConfig chans, SampleType type)
    {
        struct FormatEntry
        {
            ALenum format;
            ChannelConfig chans;
            SampleType type;
        };
        struct FormatEntryExt
        {
            const char name[32];
            ChannelConfig chans;
            SampleType type;
        };
        static const std::array<FormatEntry, 4> fmtlist{ {
            { AL_FORMAT_MONO16, ChannelConfig_Mono, SampleType_Int16 },
            { AL_FORMAT_MONO8, ChannelConfig_Mono, SampleType_UInt8 },
            { AL_FORMAT_STEREO16, ChannelConfig_Stereo, SampleType_Int16 },
            { AL_FORMAT_STEREO8, ChannelConfig_Stereo, SampleType_UInt8 },
        } };

        for (auto& fmt : fmtlist)
        {
            if (fmt.chans == chans && fmt.type == type)
                return fmt.format;
        }

        if (alIsExtensionPresent("AL_EXT_MCFORMATS"))
        {
            static const std::array<FormatEntryExt, 6> mcfmtlist{ {
                { "AL_FORMAT_QUAD16", ChannelConfig_Quad, SampleType_Int16 },
                { "AL_FORMAT_QUAD8", ChannelConfig_Quad, SampleType_UInt8 },
                { "AL_FORMAT_51CHN16", ChannelConfig_5point1, SampleType_Int16 },
                { "AL_FORMAT_51CHN8", ChannelConfig_5point1, SampleType_UInt8 },
                { "AL_FORMAT_71CHN16", ChannelConfig_7point1, SampleType_Int16 },
                { "AL_FORMAT_71CHN8", ChannelConfig_7point1, SampleType_UInt8 },
            } };

            for (auto& fmt : mcfmtlist)
            {
                if (fmt.chans == chans && fmt.type == type)
                {
                    ALenum format = alGetEnumValue(fmt.name);
                    if (format != 0 && format != -1)
                        return format;
                }
            }
        }
        if (alIsExtensionPresent("AL_EXT_FLOAT32"))
        {
            static const std::array<FormatEntryExt, 2> fltfmtlist{ {
                { "AL_FORMAT_MONO_FLOAT32", ChannelConfig_Mono, SampleType_Float32 },
                { "AL_FORMAT_STEREO_FLOAT32", ChannelConfig_Stereo, SampleType_Float32 },
            } };

            for (auto& fmt : fltfmtlist)
            {
                if (fmt.chans == chans && fmt.type == type)
                {
                    ALenum format = alGetEnumValue(fmt.name);
                    if (format != 0 && format != -1)
                        return format;
                }
            }

            if (alIsExtensionPresent("AL_EXT_MCFORMATS"))
            {
                static const std::array<FormatEntryExt, 3> fltmcfmtlist{ {
                    { "AL_FORMAT_QUAD32", ChannelConfig_Quad, SampleType_Float32 },
                    { "AL_FORMAT_51CHN32", ChannelConfig_5point1, SampleType_Float32 },
                    { "AL_FORMAT_71CHN32", ChannelConfig_7point1, SampleType_Float32 },
                } };

                for (auto& fmt : fltmcfmtlist)
                {
                    if (fmt.chans == chans && fmt.type == type)
                    {
                        ALenum format = alGetEnumValue(fmt.name);
                        if (format != 0 && format != -1)
                            return format;
                    }
                }
            }
        }

        Log(Debug::Warning) << "Unsupported sound format (" << getChannelConfigName(chans) << ", "
                            << getSampleTypeName(type) << ")";
        return AL_NONE;
    }

    //
    // A streaming OpenAL sound.
    //
    class OpenAL_SoundStream
    {
        static const ALfloat sBufferLength;

    private:
        ALuint mSource;

        std::array<ALuint, 6> mBuffers;
        ALint mCurrentBufIdx;

        ALenum mFormat;
        ALsizei mSampleRate;
        ALuint mBufferSize;
        ALuint mFrameSize;
        ALint mSilence;

        DecoderPtr mDecoder;

        std::unique_ptr<Sound_Loudness> mLoudnessAnalyzer;

        std::atomic<bool> mIsFinished;

        OpenAL_SoundStream(const OpenAL_SoundStream& rhs);
        OpenAL_SoundStream& operator=(const OpenAL_SoundStream& rhs);

        friend class OpenALOutput;

    public:
        OpenAL_SoundStream(ALuint src, DecoderPtr decoder);
        ~OpenAL_SoundStream();

        bool init(bool getLoudnessData = false);

        bool isPlaying();
        double getStreamDelay() const;
        float getStreamOffset() const;

        float getCurrentLoudness() const;

        bool process();
        ALint refillQueue();
    };
    const ALfloat OpenAL_SoundStream::sBufferLength = 0.125f;

    //
    // A background streaming thread (keeps active streams processed)
    //
    struct OpenALOutput::StreamThread
    {
        std::vector<OpenAL_SoundStream*> mStreams;

        std::atomic<bool> mQuitNow;
        std::mutex mMutex;
        std::condition_variable mCondVar;
        std::thread mThread;

        StreamThread()
            : mQuitNow(false)
#ifndef __EMSCRIPTEN__
            // Web: no background thread. Emscripten's OpenAL is JS/Web Audio — every AL call
            // from a worker sync-proxies to the main thread. This thread holds mMutex across
            // process() (AL calls), so if the main thread ever blocks on mMutex (add/remove/
            // removeAll — e.g. tearing down a movie-audio stream on intro-video skip) while
            // this thread is mid-proxy, neither can advance: the proxy needs the main loop,
            // the main loop needs mMutex → permanent freeze. Streams are pumped inline from
            // the main thread instead (pump(), called from OpenALOutput::finishUpdate and the
            // engine's cooperative video branch). 6 buffers × 0.125s gives 0.75s of queue —
            // ample for a per-frame refill.
            , mThread([this] { run(); })
#endif
        {
        }
        ~StreamThread()
        {
            mQuitNow = true;
            mMutex.lock();
            mMutex.unlock();
            mCondVar.notify_all();
#ifndef __EMSCRIPTEN__
            mThread.join();
#endif
        }

#ifdef __EMSCRIPTEN__
        // One processing pass, run on the main thread (see ctor comment). Safe: same lock,
        // same body as run()'s loop iteration, just no persistent lock across frames.
        void pump()
        {
            std::lock_guard<std::mutex> lock(mMutex);
            auto iter = mStreams.begin();
            while (iter != mStreams.end())
            {
                if ((*iter)->process() == false)
                    iter = mStreams.erase(iter);
                else
                    ++iter;
            }
        }
#endif

        // thread entry point
        void run()
        {
            std::unique_lock<std::mutex> lock(mMutex);
            while (!mQuitNow)
            {
                auto iter = mStreams.begin();
                while (iter != mStreams.end())
                {
                    if ((*iter)->process() == false)
                        iter = mStreams.erase(iter);
                    else
                        ++iter;
                }

                mCondVar.wait_for(lock, std::chrono::milliseconds(50));
            }
        }

        void add(OpenAL_SoundStream* stream)
        {
            std::lock_guard<std::mutex> lock(mMutex);
            if (std::find(mStreams.begin(), mStreams.end(), stream) == mStreams.end())
            {
                mStreams.push_back(stream);
                mCondVar.notify_all();
            }
        }

        void remove(OpenAL_SoundStream* stream)
        {
            std::lock_guard<std::mutex> lock(mMutex);
            auto iter = std::find(mStreams.begin(), mStreams.end(), stream);
            if (iter != mStreams.end())
                mStreams.erase(iter);
        }

        void removeAll()
        {
            std::lock_guard<std::mutex> lock(mMutex);
            mStreams.clear();
        }

        StreamThread(const StreamThread& rhs) = delete;
        StreamThread& operator=(const StreamThread& rhs) = delete;
    };

    class OpenALOutput::DefaultDeviceThread
    {
    public:
        std::basic_string<ALCchar> mCurrentName;

    private:
        OpenALOutput& mOutput;

        std::atomic<bool> mQuitNow;
        std::mutex mMutex;
        std::condition_variable mCondVar;
        std::thread mThread;

        DefaultDeviceThread(const DefaultDeviceThread&) = delete;
        DefaultDeviceThread& operator=(const DefaultDeviceThread&) = delete;

        void run()
        {
            Misc::setCurrentThreadIdlePriority();
            std::unique_lock<std::mutex> lock(mMutex);
            while (!mQuitNow)
            {
                {
                    const std::lock_guard<std::mutex> openLock(mOutput.mReopenMutex);
                    std::basic_string_view<ALCchar> defaultName = getDeviceName(nullptr);
                    if (mCurrentName != defaultName)
                    {
                        mCurrentName = defaultName;
                        Log(Debug::Info) << "Default audio device changed to \"" << mCurrentName << "\"";
                        ALCboolean reopened = alcReopenDeviceSOFT(
                            mOutput.mDevice, mCurrentName.data(), mOutput.mContextAttributes.data());
                        if (reopened == AL_FALSE)
                            Log(Debug::Warning) << "Failed to switch to new audio device";
                    }
                }
                mCondVar.wait_for(lock, std::chrono::seconds(2));
            }
        }

    public:
        DefaultDeviceThread(OpenALOutput& output, std::basic_string_view<ALCchar> name = {})
            : mCurrentName(name)
            , mOutput(output)
            , mQuitNow(false)
            , mThread([this] { run(); })
        {
        }

        ~DefaultDeviceThread()
        {
            mQuitNow = true;
            mMutex.lock();
            mMutex.unlock();
            mCondVar.notify_all();
            mThread.join();
        }
    };

    OpenAL_SoundStream::OpenAL_SoundStream(ALuint src, DecoderPtr decoder)
        : mSource(src)
        , mCurrentBufIdx(0)
        , mFormat(AL_NONE)
        , mSampleRate(0)
        , mBufferSize(0)
        , mFrameSize(0)
        , mSilence(0)
        , mDecoder(std::move(decoder))
        , mLoudnessAnalyzer(nullptr)
        , mIsFinished(true)
    {
        mBuffers.fill(0);
    }

    OpenAL_SoundStream::~OpenAL_SoundStream()
    {
        if (mBuffers[0] && alIsBuffer(mBuffers[0]))
            alDeleteBuffers(static_cast<ALsizei>(mBuffers.size()), mBuffers.data());
        alGetError();

        mDecoder->close();
    }

    bool OpenAL_SoundStream::init(bool getLoudnessData)
    {
        alGenBuffers(static_cast<ALsizei>(mBuffers.size()), mBuffers.data());
        ALenum err = getALError();
        if (err != AL_NO_ERROR)
            return false;

        ChannelConfig chans;
        SampleType type;

        try
        {
            mDecoder->getInfo(&mSampleRate, &chans, &type);
            mFormat = getALFormat(chans, type);
        }
        catch (std::exception& e)
        {
            Log(Debug::Error) << "Failed to get stream info: " << e.what();
            return false;
        }

        switch (type)
        {
            case SampleType_UInt8:
                mSilence = 0x80;
                break;
            case SampleType_Int16:
                mSilence = 0x00;
                break;
            case SampleType_Float32:
                mSilence = 0x00;
                break;
        }

        mFrameSize = static_cast<ALuint>(framesToBytes(1, chans, type));
        mBufferSize = static_cast<ALuint>(sBufferLength * mSampleRate);
        mBufferSize *= mFrameSize;

        if (getLoudnessData)
            mLoudnessAnalyzer = std::make_unique<Sound_Loudness>(sLoudnessFPS, mSampleRate, chans, type);

        mIsFinished = false;
        return true;
    }

    bool OpenAL_SoundStream::isPlaying()
    {
        ALint state;

        alGetSourcei(mSource, AL_SOURCE_STATE, &state);
        getALError();

        if (state == AL_PLAYING || state == AL_PAUSED)
            return true;
        return !mIsFinished;
    }

    double OpenAL_SoundStream::getStreamDelay() const
    {
        ALint state = AL_STOPPED;
        double d = 0.0;
        ALint offset;

        alGetSourcei(mSource, AL_SAMPLE_OFFSET, &offset);
        alGetSourcei(mSource, AL_SOURCE_STATE, &state);
        if (state == AL_PLAYING || state == AL_PAUSED)
        {
            ALint queued;
            alGetSourcei(mSource, AL_BUFFERS_QUEUED, &queued);
            ALint inqueue = mBufferSize / mFrameSize * queued - offset;
            d = (double)inqueue / (double)mSampleRate;
        }

        getALError();
        return d;
    }

    float OpenAL_SoundStream::getStreamOffset() const
    {
        ALint state = AL_STOPPED;
        ALint offset;
        float t;

        alGetSourcei(mSource, AL_SAMPLE_OFFSET, &offset);
        alGetSourcei(mSource, AL_SOURCE_STATE, &state);
        if (state == AL_PLAYING || state == AL_PAUSED)
        {
            ALint queued;
            alGetSourcei(mSource, AL_BUFFERS_QUEUED, &queued);
            ALint inqueue = mBufferSize / mFrameSize * queued - offset;
            t = (mDecoder->getSampleOffset() - inqueue) / static_cast<float>(mSampleRate);
        }
        else
        {
            /* Underrun, or not started yet. The decoder offset is where we'll play
             * next. */
            t = mDecoder->getSampleOffset() / static_cast<float>(mSampleRate);
        }

        getALError();
        return t;
    }

    float OpenAL_SoundStream::getCurrentLoudness() const
    {
        if (!mLoudnessAnalyzer.get())
            return 0.f;

        float time = getStreamOffset();
        return mLoudnessAnalyzer->getLoudnessAtTime(time);
    }

    bool OpenAL_SoundStream::process()
    {
        try
        {
            if (refillQueue() > 0)
            {
                ALint state;
                alGetSourcei(mSource, AL_SOURCE_STATE, &state);
                if (state != AL_PLAYING && state != AL_PAUSED)
                {
                    // Ensure all processed buffers are removed so we don't replay them.
                    refillQueue();

                    alSourcePlay(mSource);
                }
            }
        }
        catch (const std::exception& e)
        {
            Log(Debug::Error) << "Error updating stream \"" << mDecoder->getName() << "\": " << e.what();
            mIsFinished = true;
        }
        return !mIsFinished;
    }

    ALint OpenAL_SoundStream::refillQueue()
    {
        ALint processed;
        alGetSourcei(mSource, AL_BUFFERS_PROCESSED, &processed);
        while (processed > 0)
        {
            ALuint buf;
            alSourceUnqueueBuffers(mSource, 1, &buf);
            --processed;
        }

        ALint queued;
        alGetSourcei(mSource, AL_BUFFERS_QUEUED, &queued);
        if (!mIsFinished && (ALuint)queued < mBuffers.size())
        {
            std::vector<char> data(mBufferSize);
            for (; !mIsFinished && (ALuint)queued < mBuffers.size(); ++queued)
            {
                size_t got = mDecoder->read(data.data(), data.size());
                if (got < data.size())
                {
                    mIsFinished = true;
                    std::fill(data.begin() + got, data.end(), mSilence);
                }
                if (got > 0)
                {
                    if (mLoudnessAnalyzer.get())
                        mLoudnessAnalyzer->analyzeLoudness(data);

                    ALuint bufid = mBuffers[mCurrentBufIdx];
                    alBufferData(bufid, mFormat, data.data(), static_cast<ALsizei>(data.size()), mSampleRate);
                    alSourceQueueBuffers(mSource, 1, &bufid);
                    mCurrentBufIdx = (mCurrentBufIdx + 1) % mBuffers.size();
                }
            }
        }

        return queued;
    }

    //
    // An OpenAL output device
    //
    std::vector<std::string> OpenALOutput::enumerate()
    {
        std::vector<std::string> devlist;
        const ALCchar* devnames;

        if (alcIsExtensionPresent(nullptr, "ALC_ENUMERATE_ALL_EXT"))
            devnames = alcGetString(nullptr, ALC_ALL_DEVICES_SPECIFIER);
        else
            devnames = alcGetString(nullptr, ALC_DEVICE_SPECIFIER);
        while (devnames && *devnames)
        {
            devlist.emplace_back(devnames);
            devnames += strlen(devnames) + 1;
        }
        return devlist;
    }

    void OpenALOutput::eventCallback(
        ALenum eventType, ALuint object, ALuint param, ALsizei length, const ALchar* message, void* userParam)
    {
        if (eventType == AL_EVENT_TYPE_DISCONNECTED_SOFT)
            static_cast<OpenALOutput*>(userParam)->onDisconnect();
    }

    void OpenALOutput::onDisconnect()
    {
        if (!mInitialized || !alcReopenDeviceSOFT)
            return;
        const std::lock_guard<std::mutex> lock(mReopenMutex);
        Log(Debug::Warning) << "Audio device disconnected, attempting to reopen...";
        ALCboolean reopened = alcReopenDeviceSOFT(mDevice, mDeviceName.c_str(), mContextAttributes.data());
        if (reopened == AL_FALSE && !mDeviceName.empty())
        {
            reopened = alcReopenDeviceSOFT(mDevice, nullptr, mContextAttributes.data());
            if (reopened == AL_TRUE && !mDefaultDeviceThread)
                mDefaultDeviceThread = std::make_unique<DefaultDeviceThread>(*this);
        }
        if (reopened == AL_FALSE)
            Log(Debug::Error) << "Failed to reopen audio device";
        else
        {
            Log(Debug::Info) << "Reopened audio device";
            if (mDefaultDeviceThread)
                mDefaultDeviceThread->mCurrentName = getDeviceName(mDevice);
        }
    }

    bool OpenALOutput::init(const std::string& devname, const std::string& hrtfname, HrtfMode hrtfmode)
    {
        deinit();
        std::lock_guard<std::mutex> lock(mReopenMutex);

        Log(Debug::Info) << "Initializing OpenAL...";

        mDeviceName = devname;
#ifdef __EMSCRIPTEN__
        // Emscripten's alcOpenDevice only accepts nullptr or the exact string
        // "Emscripten OpenAL"; an empty name (the default "device =" setting) returns 0,
        // and OpenMW's fallback below is skipped because devname is empty -> no audio.
        if (mDeviceName.empty())
            mDeviceName = "Emscripten OpenAL";
        mDevice = alcOpenDevice(mDeviceName.c_str());
        if (!mDevice)
        {
            Log(Debug::Warning) << "Failed to open \"" << mDeviceName << "\", trying default";
            mDevice = alcOpenDevice(nullptr);
            mDeviceName.clear();
        }
#else
        mDevice = alcOpenDevice(devname.c_str());
        if (!mDevice && !devname.empty())
        {
            Log(Debug::Warning) << "Failed to open \"" << devname << "\", trying default";
            mDevice = alcOpenDevice(nullptr);
            mDeviceName.clear();
        }
#endif

        if (!mDevice)
        {
            Log(Debug::Error) << "Failed to open default audio device";
            return false;
        }

        auto name = getDeviceName(mDevice);
        Log(Debug::Info) << "Opened \"" << name << "\"";

        ALCint major = 0, minor = 0;
        alcGetIntegerv(mDevice, ALC_MAJOR_VERSION, 1, &major);
        alcGetIntegerv(mDevice, ALC_MINOR_VERSION, 1, &minor);
        Log(Debug::Info) << "  ALC Version: " << major << "." << minor << "\n"
                         << "  ALC Extensions: " << alcGetString(mDevice, ALC_EXTENSIONS);

        ALC.EXT_EFX = alcIsExtensionPresent(mDevice, "ALC_EXT_EFX");
#ifdef __EMSCRIPTEN__
        // Emscripten's OpenAL has no EFX; the Web Audio shim above provides it.
        ALC.EXT_EFX = true;
        omw_efx_setup();
#endif
        ALC.SOFT_HRTF = alcIsExtensionPresent(mDevice, "ALC_SOFT_HRTF");

        mContextAttributes.clear();
        mContextAttributes.reserve(15);
        if (ALC.SOFT_HRTF)
        {
            LPALCGETSTRINGISOFT alcGetStringiSOFT = nullptr;
            getALCFunc(alcGetStringiSOFT, mDevice, "alcGetStringiSOFT");

            mContextAttributes.push_back(ALC_HRTF_SOFT);
            mContextAttributes.push_back(hrtfmode == HrtfMode::Disable ? ALC_FALSE
                    : hrtfmode == HrtfMode::Enable                     ? ALC_TRUE
                                                                       :
                                                   /*hrtfmode == HrtfMode::Auto ?*/ ALC_DONT_CARE_SOFT);
            if (!hrtfname.empty())
            {
                ALCint index = -1;
                ALCint numHrtf;
                alcGetIntegerv(mDevice, ALC_NUM_HRTF_SPECIFIERS_SOFT, 1, &numHrtf);
                for (ALCint i = 0; i < numHrtf; ++i)
                {
                    const ALCchar* entry = alcGetStringiSOFT(mDevice, ALC_HRTF_SPECIFIER_SOFT, i);
                    if (hrtfname == entry)
                    {
                        index = i;
                        break;
                    }
                }

                if (index < 0)
                    Log(Debug::Warning) << "Failed to find HRTF \"" << hrtfname << "\", using default";
                else
                {
                    mContextAttributes.push_back(ALC_HRTF_ID_SOFT);
                    mContextAttributes.push_back(index);
                }
            }
        }
        mContextAttributes.push_back(0);

        mContext = alcCreateContext(mDevice, mContextAttributes.data());
        if (!mContext || alcMakeContextCurrent(mContext) == ALC_FALSE)
        {
            Log(Debug::Error) << "Failed to setup audio context: " << alcGetString(mDevice, alcGetError(mDevice));
            if (mContext)
                alcDestroyContext(mContext);
            mContext = nullptr;
            alcCloseDevice(mDevice);
            mDevice = nullptr;
            return false;
        }

        Log(Debug::Info) << "  Vendor: " << alGetString(AL_VENDOR) << "\n"
                         << "  Renderer: " << alGetString(AL_RENDERER) << "\n"
                         << "  Version: " << alGetString(AL_VERSION) << "\n"
                         << "  Extensions: " << alGetString(AL_EXTENSIONS);

        if (alIsExtensionPresent("AL_SOFT_events"))
        {
            getALFunc(alEventControlSOFT, "alEventControlSOFT");
            getALFunc(alEventCallbackSOFT, "alEventCallbackSOFT");
        }
        if (alcIsExtensionPresent(mDevice, "ALC_SOFT_reopen_device"))
            getALFunc(alcReopenDeviceSOFT, "alcReopenDeviceSOFT");
        if (alEventControlSOFT)
        {
            static const std::array<ALenum, 1> events{ { AL_EVENT_TYPE_DISCONNECTED_SOFT } };
            alEventControlSOFT(static_cast<ALsizei>(events.size()), events.data(), AL_TRUE);
            alEventCallbackSOFT(&OpenALOutput::eventCallback, this);
        }
        else
#ifdef __EMSCRIPTEN__
            // Emscripten's OpenAL has no AL_SOFT_events (hotplug detection); audio still works.
            // Verbose so it stays out of the normal-level console.
            Log(Debug::Verbose) << "Audio device change detection unavailable (Emscripten OpenAL)";
#else
            Log(Debug::Warning) << "Cannot detect audio device changes";
#endif
        if (mDeviceName.empty() && !name.empty())
        {
            // If we opened the default device, switch devices if a new default is selected
            if (alcReopenDeviceSOFT)
                mDefaultDeviceThread = std::make_unique<DefaultDeviceThread>(*this, name);
#ifndef __EMSCRIPTEN__
            else
                Log(Debug::Warning) << "Cannot switch audio devices if the default changes";
#endif
        }

        if (!ALC.SOFT_HRTF)
            Log(Debug::Warning) << "HRTF status unavailable";
        else
        {
            ALCint hrtfState;
            alcGetIntegerv(mDevice, ALC_HRTF_SOFT, 1, &hrtfState);
            if (!hrtfState)
                Log(Debug::Info) << "HRTF disabled";
            else
            {
                const ALCchar* hrtf = alcGetString(mDevice, ALC_HRTF_SPECIFIER_SOFT);
                Log(Debug::Info) << "Enabled HRTF " << hrtf;
            }
        }

        AL.SOFT_source_spatialize = alIsExtensionPresent("AL_SOFT_source_spatialize");

        ALCuint maxtotal;
        ALCint maxmono = 0, maxstereo = 0;
        alcGetIntegerv(mDevice, ALC_MONO_SOURCES, 1, &maxmono);
        alcGetIntegerv(mDevice, ALC_STEREO_SOURCES, 1, &maxstereo);
        if (getALCError(mDevice) != ALC_NO_ERROR)
            maxtotal = 256;
        else
        {
            maxtotal = std::min<ALCuint>(maxmono + maxstereo, 256);
            if (maxtotal == 0) // workaround for broken implementations
                maxtotal = 256;
        }
        for (size_t i = 0; i < maxtotal; i++)
        {
            ALuint src = 0;
            alGenSources(1, &src);
            if (alGetError() != AL_NO_ERROR)
                break;
            mFreeSources.push_back(src);
        }
        if (mFreeSources.empty())
        {
            Log(Debug::Warning) << "Could not allocate any sound sourcess";
            alcMakeContextCurrent(nullptr);
            alcDestroyContext(mContext);
            mContext = nullptr;
            alcCloseDevice(mDevice);
            mDevice = nullptr;
            return false;
        }
        Log(Debug::Info) << "Allocated " << mFreeSources.size() << " sound sources";

        if (ALC.EXT_EFX)
        {
#ifdef __EMSCRIPTEN__
#define LOAD_FUNC(x) x = &EfxShim::x
#else
#define LOAD_FUNC(x) getALFunc(x, #x)
#endif
            LOAD_FUNC(alGenEffects);
            LOAD_FUNC(alDeleteEffects);
            LOAD_FUNC(alIsEffect);
            LOAD_FUNC(alEffecti);
            LOAD_FUNC(alEffectiv);
            LOAD_FUNC(alEffectf);
            LOAD_FUNC(alEffectfv);
            LOAD_FUNC(alGetEffecti);
            LOAD_FUNC(alGetEffectiv);
            LOAD_FUNC(alGetEffectf);
            LOAD_FUNC(alGetEffectfv);
            LOAD_FUNC(alGenFilters);
            LOAD_FUNC(alDeleteFilters);
            LOAD_FUNC(alIsFilter);
            LOAD_FUNC(alFilteri);
            LOAD_FUNC(alFilteriv);
            LOAD_FUNC(alFilterf);
            LOAD_FUNC(alFilterfv);
            LOAD_FUNC(alGetFilteri);
            LOAD_FUNC(alGetFilteriv);
            LOAD_FUNC(alGetFilterf);
            LOAD_FUNC(alGetFilterfv);
            LOAD_FUNC(alGenAuxiliaryEffectSlots);
            LOAD_FUNC(alDeleteAuxiliaryEffectSlots);
            LOAD_FUNC(alIsAuxiliaryEffectSlot);
            LOAD_FUNC(alAuxiliaryEffectSloti);
            LOAD_FUNC(alAuxiliaryEffectSlotiv);
            LOAD_FUNC(alAuxiliaryEffectSlotf);
            LOAD_FUNC(alAuxiliaryEffectSlotfv);
            LOAD_FUNC(alGetAuxiliaryEffectSloti);
            LOAD_FUNC(alGetAuxiliaryEffectSlotiv);
            LOAD_FUNC(alGetAuxiliaryEffectSlotf);
            LOAD_FUNC(alGetAuxiliaryEffectSlotfv);
#undef LOAD_FUNC
            if (getALError() != AL_NO_ERROR)
            {
                ALC.EXT_EFX = false;
                goto skip_efx;
            }

            alGenFilters(1, &mWaterFilter);
            if (alGetError() == AL_NO_ERROR)
            {
                alFilteri(mWaterFilter, AL_FILTER_TYPE, AL_FILTER_LOWPASS);
                if (alGetError() == AL_NO_ERROR)
                {
                    Log(Debug::Info) << "Low-pass filter supported";
                    alFilterf(mWaterFilter, AL_LOWPASS_GAIN, 0.9f);
                    alFilterf(mWaterFilter, AL_LOWPASS_GAINHF, 0.125f);
                }
                else
                {
                    alDeleteFilters(1, &mWaterFilter);
                    mWaterFilter = 0;
                }
                alGetError();
            }

            alGenAuxiliaryEffectSlots(1, &mEffectSlot);
            alGetError();

            alGenEffects(1, &mDefaultEffect);
            if (alGetError() == AL_NO_ERROR)
            {
                alEffecti(mDefaultEffect, AL_EFFECT_TYPE, AL_EFFECT_EAXREVERB);
                if (alGetError() == AL_NO_ERROR)
                    Log(Debug::Info) << "EAX Reverb supported";
                else
                {
                    alEffecti(mDefaultEffect, AL_EFFECT_TYPE, AL_EFFECT_REVERB);
                    if (alGetError() == AL_NO_ERROR)
                        Log(Debug::Info) << "Standard Reverb supported";
                }
                EFXEAXREVERBPROPERTIES props = EFX_REVERB_PRESET_LIVINGROOM;
                props.flGain = 0.0f;
                LoadEffect(mDefaultEffect, props);
            }

            alGenEffects(1, &mWaterEffect);
            if (alGetError() == AL_NO_ERROR)
            {
                alEffecti(mWaterEffect, AL_EFFECT_TYPE, AL_EFFECT_EAXREVERB);
                if (alGetError() != AL_NO_ERROR)
                {
                    alEffecti(mWaterEffect, AL_EFFECT_TYPE, AL_EFFECT_REVERB);
                    alGetError();
                }
                LoadEffect(mWaterEffect, EFX_REVERB_PRESET_UNDERWATER);
            }

#ifndef __EMSCRIPTEN__
            // (Not on emscripten: its Web Audio OpenAL doesn't know this EFX listener param
            // and raises AL_INVALID_ENUM; the shim doesn't model air absorption anyway.)
            alListenerf(AL_METERS_PER_UNIT, 1.0f / Constants::UnitsPerMeter);
#endif
        }
    skip_efx:
        alDistanceModel(AL_INVERSE_DISTANCE_CLAMPED);
        // Speed of sound is in units per second. Take the sound speed in air (assumed
        // meters per second), multiply by the units per meter to get the speed in u/s.
        alSpeedOfSound(Constants::SoundSpeedInAir * Constants::UnitsPerMeter);
        alDopplerFactor(Settings::sound().mDopplerFactor);
        alGetError();

        mInitialized = true;
        return true;
    }

    void OpenALOutput::deinit()
    {
        mStreamThread->removeAll();
        mDefaultDeviceThread.reset();

        for (ALuint source : mFreeSources)
            alDeleteSources(1, &source);
        mFreeSources.clear();

        if (mEffectSlot)
            alDeleteAuxiliaryEffectSlots(1, &mEffectSlot);
        mEffectSlot = 0;
        if (mDefaultEffect)
            alDeleteEffects(1, &mDefaultEffect);
        mDefaultEffect = 0;
        if (mWaterEffect)
            alDeleteEffects(1, &mWaterEffect);
        mWaterEffect = 0;
        if (mWaterFilter)
            alDeleteFilters(1, &mWaterFilter);
        mWaterFilter = 0;

        if (alEventCallbackSOFT)
            alEventCallbackSOFT(nullptr, nullptr);

        alcMakeContextCurrent(nullptr);
        if (mContext)
            alcDestroyContext(mContext);
        mContext = nullptr;
        if (mDevice)
            alcCloseDevice(mDevice);
        mDevice = nullptr;

        mInitialized = false;
    }

    std::vector<std::string> OpenALOutput::enumerateHrtf()
    {
        std::vector<std::string> ret;

        if (!mDevice || !ALC.SOFT_HRTF)
            return ret;

        LPALCGETSTRINGISOFT alcGetStringiSOFT = nullptr;
        getALCFunc(alcGetStringiSOFT, mDevice, "alcGetStringiSOFT");

        ALCint numHrtf;
        alcGetIntegerv(mDevice, ALC_NUM_HRTF_SPECIFIERS_SOFT, 1, &numHrtf);
        ret.reserve(numHrtf);
        for (ALCint i = 0; i < numHrtf; ++i)
        {
            const ALCchar* entry = alcGetStringiSOFT(mDevice, ALC_HRTF_SPECIFIER_SOFT, i);
            ret.emplace_back(entry);
        }

        return ret;
    }

    std::pair<Sound_Handle, size_t> OpenALOutput::loadSound(VFS::Path::NormalizedView fname)
    {
        getALError();

        std::vector<char> data;
        ALenum format = AL_NONE;
        int srate = 0;

        try
        {
            DecoderPtr decoder = mManager.getDecoder();
            decoder->open(Misc::ResourceHelpers::correctSoundPath(fname, *decoder->mResourceMgr));

            ChannelConfig chans;
            SampleType type;
            decoder->getInfo(&srate, &chans, &type);
            format = getALFormat(chans, type);
            if (format)
                decoder->readAll(data);
        }
        catch (std::exception& e)
        {
            Log(Debug::Error) << "Failed to load audio from " << fname << ": " << e.what();
        }

        if (data.empty())
        {
            // If we failed to get any usable audio, substitute with silence.
            format = AL_FORMAT_MONO8;
            srate = 8000;
            data.assign(8000, -128);
        }

        ALint size;
        ALuint buf = 0;
        alGenBuffers(1, &buf);
        alBufferData(buf, format, data.data(), static_cast<ALsizei>(data.size()), srate);
        alGetBufferi(buf, AL_SIZE, &size);
        if (getALError() != AL_NO_ERROR)
        {
            if (buf && alIsBuffer(buf))
                alDeleteBuffers(1, &buf);
            getALError();
            return std::make_pair(nullptr, 0);
        }
        return std::make_pair(MAKE_PTRID(buf), size);
    }

    size_t OpenALOutput::unloadSound(Sound_Handle data)
    {
        ALuint buffer = GET_PTRID(data);
        if (!buffer)
            return 0;

        // Make sure no sources are playing this buffer before unloading it.
        SoundVec::const_iterator iter = mActiveSounds.begin();
        for (; iter != mActiveSounds.end(); ++iter)
        {
            if (!(*iter)->mHandle)
                continue;

            ALuint source = GET_PTRID((*iter)->mHandle);
            ALint srcbuf;
            alGetSourcei(source, AL_BUFFER, &srcbuf);
            if ((ALuint)srcbuf == buffer)
            {
                alSourceStop(source);
                alSourcei(source, AL_BUFFER, 0);
            }
        }
        ALint size = 0;
        alGetBufferi(buffer, AL_SIZE, &size);
        alDeleteBuffers(1, &buffer);
        getALError();
        return size;
    }

    void OpenALOutput::initCommon2D(
        ALuint source, const osg::Vec3f& pos, ALfloat gain, ALfloat pitch, bool loop, bool useenv)
    {
        alSourcef(source, AL_REFERENCE_DISTANCE, 1.0f);
        alSourcef(source, AL_MAX_DISTANCE, 1000.0f);
        alSourcef(source, AL_ROLLOFF_FACTOR, 0.0f);
        alSourcei(source, AL_SOURCE_RELATIVE, AL_TRUE);
        alSourcei(source, AL_LOOPING, loop ? AL_TRUE : AL_FALSE);
        if (AL.SOFT_source_spatialize)
            alSourcei(source, AL_SOURCE_SPATIALIZE_SOFT, AL_FALSE);

        if (useenv)
        {
            if (mWaterFilter)
                omwSetSourceDirectFilter(source, (mListenerEnv == Env_Underwater) ? mWaterFilter : AL_FILTER_NULL);
            else if (mListenerEnv == Env_Underwater)
            {
                gain *= 0.9f;
                pitch *= 0.7f;
            }
            if (mEffectSlot)
                omwSetSourceSendFilter(source, mEffectSlot, AL_FILTER_NULL);
        }
        else
        {
            if (mWaterFilter)
                omwSetSourceDirectFilter(source, AL_FILTER_NULL);
            if (mEffectSlot)
                omwSetSourceSendFilter(source, AL_EFFECTSLOT_NULL, AL_FILTER_NULL);
        }

        alSourcef(source, AL_GAIN, gain);
        alSourcef(source, AL_PITCH, pitch);
        alSourcefv(source, AL_POSITION, pos.ptr());
        alSource3f(source, AL_DIRECTION, 0.0f, 0.0f, 0.0f);
        alSource3f(source, AL_VELOCITY, 0.0f, 0.0f, 0.0f);
    }

    void OpenALOutput::initCommon3D(ALuint source, const osg::Vec3f& pos, const osg::Vec3f& vel, ALfloat mindist,
        ALfloat maxdist, ALfloat gain, ALfloat pitch, bool loop, bool useenv)
    {
        alSourcef(source, AL_REFERENCE_DISTANCE, mindist);
        alSourcef(source, AL_MAX_DISTANCE, maxdist);
        alSourcef(source, AL_ROLLOFF_FACTOR, 1.0f);
        alSourcei(source, AL_SOURCE_RELATIVE, AL_FALSE);
        alSourcei(source, AL_LOOPING, loop ? AL_TRUE : AL_FALSE);
        if (AL.SOFT_source_spatialize)
            alSourcei(source, AL_SOURCE_SPATIALIZE_SOFT, AL_TRUE);

        if ((pos - mListenerPos).length2() > maxdist * maxdist)
            gain = 0.0f;
        if (useenv)
        {
            if (mWaterFilter)
                omwSetSourceDirectFilter(source, (mListenerEnv == Env_Underwater) ? mWaterFilter : AL_FILTER_NULL);
            else if (mListenerEnv == Env_Underwater)
            {
                gain *= 0.9f;
                pitch *= 0.7f;
            }
            if (mEffectSlot)
                omwSetSourceSendFilter(source, mEffectSlot, AL_FILTER_NULL);
        }
        else
        {
            if (mWaterFilter)
                omwSetSourceDirectFilter(source, AL_FILTER_NULL);
            if (mEffectSlot)
                omwSetSourceSendFilter(source, AL_EFFECTSLOT_NULL, AL_FILTER_NULL);
        }

        alSourcef(source, AL_GAIN, gain);
        alSourcef(source, AL_PITCH, pitch);
        alSourcefv(source, AL_POSITION, pos.ptr());
        alSource3f(source, AL_DIRECTION, 0.0f, 0.0f, 0.0f);
        alSourcefv(source, AL_VELOCITY, vel.ptr());
    }

    void OpenALOutput::updateCommon(ALuint source, const osg::Vec3f& pos, const osg::Vec3f& vel, ALfloat maxdist,
        ALfloat gain, ALfloat pitch, bool useenv)
    {
        if (useenv && mListenerEnv == Env_Underwater && !mWaterFilter)
        {
            gain *= 0.9f;
            pitch *= 0.7f;
        }

        alSourcef(source, AL_GAIN, gain);
        alSourcef(source, AL_PITCH, pitch);
        alSourcefv(source, AL_POSITION, pos.ptr());
        alSource3f(source, AL_DIRECTION, 0.0f, 0.0f, 0.0f);
        alSourcefv(source, AL_VELOCITY, vel.ptr());
    }

    bool OpenALOutput::playSound(Sound* sound, Sound_Handle data, float offset)
    {
        ALuint source;

        if (mFreeSources.empty())
        {
            Log(Debug::Warning) << "No free sources!";
            return false;
        }
        source = mFreeSources.front();

        initCommon2D(source, sound->getPosition(), sound->getRealVolume(), getTimeScaledPitch(sound),
            sound->getIsLooping(), sound->getUseEnv());
        alSourcei(source, AL_BUFFER, GET_PTRID(data));
        alSourcef(source, AL_SEC_OFFSET, offset);
        if (getALError() != AL_NO_ERROR)
        {
            alSourceRewind(source);
            alSourcei(source, AL_BUFFER, 0);
            alGetError();
            return false;
        }

        alSourcePlay(source);
        if (getALError() != AL_NO_ERROR)
        {
            alSourceRewind(source);
            alSourcei(source, AL_BUFFER, 0);
            alGetError();
            return false;
        }

        mFreeSources.pop_front();
        sound->mHandle = MAKE_PTRID(source);
        mActiveSounds.push_back(sound);

        return true;
    }

    bool OpenALOutput::playSound3D(Sound* sound, Sound_Handle data, float offset)
    {
        ALuint source;

        if (mFreeSources.empty())
        {
            Log(Debug::Warning) << "No free sources!";
            return false;
        }
        source = mFreeSources.front();

        initCommon3D(source, sound->getPosition(), sound->getVelocity(), sound->getMinDistance(),
            sound->getMaxDistance(), sound->getRealVolume(), getTimeScaledPitch(sound), sound->getIsLooping(),
            sound->getUseEnv());
        alSourcei(source, AL_BUFFER, GET_PTRID(data));
        alSourcef(source, AL_SEC_OFFSET, offset);
        if (getALError() != AL_NO_ERROR)
        {
            alSourceRewind(source);
            alSourcei(source, AL_BUFFER, 0);
            alGetError();
            return false;
        }

        alSourcePlay(source);
        if (getALError() != AL_NO_ERROR)
        {
            alSourceRewind(source);
            alSourcei(source, AL_BUFFER, 0);
            alGetError();
            return false;
        }

        mFreeSources.pop_front();
        sound->mHandle = MAKE_PTRID(source);
        mActiveSounds.push_back(sound);

        return true;
    }

    void OpenALOutput::finishSound(Sound* sound)
    {
        if (!sound->mHandle)
            return;
        ALuint source = GET_PTRID(sound->mHandle);
        sound->mHandle = nullptr;

        // Rewind the stream to put the source back into an AL_INITIAL state, for
        // the next time it's used.
        alSourceRewind(source);
        alSourcei(source, AL_BUFFER, 0);
        getALError();

        mFreeSources.push_back(source);
        mActiveSounds.erase(std::find(mActiveSounds.begin(), mActiveSounds.end(), sound));
    }

    bool OpenALOutput::isSoundPlaying(Sound* sound)
    {
        if (!sound->mHandle)
            return false;
        ALuint source = GET_PTRID(sound->mHandle);
        ALint state = AL_STOPPED;

        alGetSourcei(source, AL_SOURCE_STATE, &state);
        getALError();

        return state == AL_PLAYING || state == AL_PAUSED;
    }

    void OpenALOutput::updateSound(Sound* sound)
    {
        if (!sound->mHandle)
            return;
        ALuint source = GET_PTRID(sound->mHandle);

        updateCommon(source, sound->getPosition(), sound->getVelocity(), sound->getMaxDistance(),
            sound->getRealVolume(), getTimeScaledPitch(sound), sound->getUseEnv());
        getALError();
    }

    bool OpenALOutput::streamSound(DecoderPtr decoder, Stream* sound, bool getLoudnessData)
    {
        if (mFreeSources.empty())
        {
            Log(Debug::Warning) << "No free sources!";
            return false;
        }
        ALuint source = mFreeSources.front();

        if (sound->getIsLooping())
            Log(Debug::Warning) << "Warning: cannot loop stream \"" << decoder->getName() << "\"";

        initCommon2D(
            source, sound->getPosition(), sound->getRealVolume(), getTimeScaledPitch(sound), false, sound->getUseEnv());
        if (getALError() != AL_NO_ERROR)
            return false;

        OpenAL_SoundStream* stream = new OpenAL_SoundStream(source, std::move(decoder));
        if (!stream->init(getLoudnessData))
        {
            delete stream;
            return false;
        }
        mStreamThread->add(stream);

        mFreeSources.pop_front();
        sound->mHandle = stream;
        mActiveStreams.push_back(sound);
        return true;
    }

    bool OpenALOutput::streamSound3D(DecoderPtr decoder, Stream* sound, bool getLoudnessData)
    {
        if (mFreeSources.empty())
        {
            Log(Debug::Warning) << "No free sources!";
            return false;
        }
        ALuint source = mFreeSources.front();

        if (sound->getIsLooping())
            Log(Debug::Warning) << "Warning: cannot loop stream \"" << decoder->getName() << "\"";

        initCommon3D(source, sound->getPosition(), sound->getVelocity(), sound->getMinDistance(),
            sound->getMaxDistance(), sound->getRealVolume(), getTimeScaledPitch(sound), false, sound->getUseEnv());
        if (getALError() != AL_NO_ERROR)
            return false;

        OpenAL_SoundStream* stream = new OpenAL_SoundStream(source, std::move(decoder));
        if (!stream->init(getLoudnessData))
        {
            delete stream;
            return false;
        }
        mStreamThread->add(stream);

        mFreeSources.pop_front();
        sound->mHandle = stream;
        mActiveStreams.push_back(sound);
        return true;
    }

    void OpenALOutput::finishStream(Stream* sound)
    {
        if (!sound->mHandle)
            return;
        OpenAL_SoundStream* stream = reinterpret_cast<OpenAL_SoundStream*>(sound->mHandle);
        ALuint source = stream->mSource;

        sound->mHandle = nullptr;
        mStreamThread->remove(stream);

        // Rewind the stream to put the source back into an AL_INITIAL state, for
        // the next time it's used.
        alSourceRewind(source);
        alSourcei(source, AL_BUFFER, 0);
        getALError();

        mFreeSources.push_back(source);
        mActiveStreams.erase(std::find(mActiveStreams.begin(), mActiveStreams.end(), sound));

        delete stream;
    }

    double OpenALOutput::getStreamDelay(Stream* sound)
    {
        if (!sound->mHandle)
            return 0.0;
        OpenAL_SoundStream* stream = reinterpret_cast<OpenAL_SoundStream*>(sound->mHandle);
        return stream->getStreamDelay();
    }

    float OpenALOutput::getStreamOffset(Stream* sound)
    {
        if (!sound->mHandle)
            return 0.f;
        OpenAL_SoundStream* stream = reinterpret_cast<OpenAL_SoundStream*>(sound->mHandle);
        std::lock_guard<std::mutex> lock(mStreamThread->mMutex);
        return stream->getStreamOffset();
    }

    float OpenALOutput::getStreamLoudness(Stream* sound)
    {
        if (!sound->mHandle)
            return 0.0;
        OpenAL_SoundStream* stream = reinterpret_cast<OpenAL_SoundStream*>(sound->mHandle);
        std::lock_guard<std::mutex> lock(mStreamThread->mMutex);
        return stream->getCurrentLoudness();
    }

    bool OpenALOutput::isStreamPlaying(Stream* sound)
    {
        if (!sound->mHandle)
            return false;
        OpenAL_SoundStream* stream = reinterpret_cast<OpenAL_SoundStream*>(sound->mHandle);
        std::lock_guard<std::mutex> lock(mStreamThread->mMutex);
        return stream->isPlaying();
    }

    void OpenALOutput::updateStream(Stream* sound)
    {
        if (!sound->mHandle)
            return;
        OpenAL_SoundStream* stream = reinterpret_cast<OpenAL_SoundStream*>(sound->mHandle);
        ALuint source = stream->mSource;

        updateCommon(source, sound->getPosition(), sound->getVelocity(), sound->getMaxDistance(),
            sound->getRealVolume(), getTimeScaledPitch(sound), sound->getUseEnv());
        getALError();
    }

    void OpenALOutput::startUpdate()
    {
        alcSuspendContext(alcGetCurrentContext());
    }

    void OpenALOutput::finishUpdate()
    {
        alcProcessContext(alcGetCurrentContext());
#ifdef __EMSCRIPTEN__
        // No background StreamThread on the web (see StreamThread ctor) — refill active
        // audio streams inline here, once per SoundManager::update.
        if (mStreamThread)
            mStreamThread->pump();
#endif
    }

    void OpenALOutput::updateListener(
        const osg::Vec3f& pos, const osg::Vec3f& atdir, const osg::Vec3f& updir, const osg::Vec3f& vel, Environment env)
    {
        if (mContext)
        {
            ALfloat orient[6] = { atdir.x(), atdir.y(), atdir.z(), updir.x(), updir.y(), updir.z() };
            alListenerfv(AL_POSITION, pos.ptr());
            alListenerfv(AL_VELOCITY, vel.ptr());
            alListenerfv(AL_ORIENTATION, orient);

            if (env != mListenerEnv)
            {
                alSpeedOfSound(((env == Env_Underwater) ? Constants::SoundSpeedUnderwater : Constants::SoundSpeedInAir)
                    * Constants::UnitsPerMeter);

                // Update active sources with the environment's direct filter
                if (mWaterFilter)
                {
                    ALuint filter = (env == Env_Underwater) ? mWaterFilter : AL_FILTER_NULL;
                    for (Sound* sound : mActiveSounds)
                    {
                        if (sound->getUseEnv())
                            alSourcei(GET_PTRID(sound->mHandle), AL_DIRECT_FILTER, filter);
                    }
                    for (Stream* sound : mActiveStreams)
                    {
                        if (sound->getUseEnv())
                            omwSetSourceDirectFilter(reinterpret_cast<OpenAL_SoundStream*>(sound->mHandle)->mSource, filter);
                    }
                }
                // Update the environment effect
                if (mEffectSlot)
                    alAuxiliaryEffectSloti(
                        mEffectSlot, AL_EFFECTSLOT_EFFECT, (env == Env_Underwater) ? mWaterEffect : mDefaultEffect);
            }
            getALError();
        }

        mListenerPos = pos;
        mListenerVel = vel;
        mListenerEnv = env;
    }

    void OpenALOutput::pauseSounds(int types)
    {
        std::vector<ALuint> sources;
        for (Sound* sound : mActiveSounds)
        {
            if ((types & sound->getPlayType()))
                sources.push_back(GET_PTRID(sound->mHandle));
        }
        for (Stream* sound : mActiveStreams)
        {
            if ((types & sound->getPlayType()))
            {
                OpenAL_SoundStream* stream = reinterpret_cast<OpenAL_SoundStream*>(sound->mHandle);
                sources.push_back(stream->mSource);
            }
        }
        if (!sources.empty())
        {
            alSourcePausev(static_cast<ALsizei>(sources.size()), sources.data());
            getALError();
        }
    }

    void OpenALOutput::pauseActiveDevice()
    {
        if (mDevice == nullptr)
            return;

        if (alcIsExtensionPresent(mDevice, "ALC_SOFT_PAUSE_DEVICE"))
        {
            LPALCDEVICEPAUSESOFT alcDevicePauseSOFT = nullptr;
            getALCFunc(alcDevicePauseSOFT, mDevice, "alcDevicePauseSOFT");
            alcDevicePauseSOFT(mDevice);
            getALCError(mDevice);
        }

        alListenerf(AL_GAIN, 0.0f);
    }

    void OpenALOutput::resumeActiveDevice()
    {
        if (mDevice == nullptr)
            return;

        if (alcIsExtensionPresent(mDevice, "ALC_SOFT_PAUSE_DEVICE"))
        {
            LPALCDEVICERESUMESOFT alcDeviceResumeSOFT = nullptr;
            getALCFunc(alcDeviceResumeSOFT, mDevice, "alcDeviceResumeSOFT");
            alcDeviceResumeSOFT(mDevice);
            getALCError(mDevice);
        }

        alListenerf(AL_GAIN, 1.0f);
    }

    void OpenALOutput::resumeSounds(int types)
    {
        std::vector<ALuint> sources;
        for (Sound* sound : mActiveSounds)
        {
            if ((types & sound->getPlayType()))
                sources.push_back(GET_PTRID(sound->mHandle));
        }
        for (Stream* sound : mActiveStreams)
        {
            if ((types & sound->getPlayType()))
            {
                OpenAL_SoundStream* stream = reinterpret_cast<OpenAL_SoundStream*>(sound->mHandle);
                sources.push_back(stream->mSource);
            }
        }
        if (!sources.empty())
        {
            alSourcePlayv(static_cast<ALsizei>(sources.size()), sources.data());
            getALError();
        }
    }

    OpenALOutput::OpenALOutput(SoundManager& mgr)
        : SoundOutput(mgr)
        , mDevice(nullptr)
        , mContext(nullptr)
        , mListenerEnv(Env_Normal)
        , mWaterFilter(0)
        , mWaterEffect(0)
        , mDefaultEffect(0)
        , mEffectSlot(0)
        , mStreamThread(std::make_unique<StreamThread>())
    {
    }

    OpenALOutput::~OpenALOutput()
    {
        OpenALOutput::deinit();
    }

    float OpenALOutput::getTimeScaledPitch(SoundBase* sound)
    {
        const bool shouldScale = !(sound->mParams.mFlags & PlayMode::NoScaling);
        return shouldScale ? sound->getPitch() * mManager.getSimulationTimeScale() : sound->getPitch();
    }

}
