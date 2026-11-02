#include "skyextensions.hpp"

#include <algorithm>

#include <components/compiler/opcodes.hpp>

#include <components/esm3/loadregn.hpp>
#include <components/interpreter/context.hpp>
#include <components/interpreter/interpreter.hpp>
#include <components/interpreter/opcodes.hpp>
#include <components/interpreter/runtime.hpp>

#include "../mwbase/environment.hpp"
#include "../mwbase/world.hpp"

#include "../mwmp/puppets.hpp"
#include "../mwworld/esmstore.hpp"

namespace MWScript
{
    namespace Sky
    {
        class OpToggleSky : public Interpreter::Opcode0
        {
        public:
            void execute(Interpreter::Runtime& runtime) override
            {
                bool enabled = MWBase::Environment::get().getWorld()->toggleSky();

                runtime.getContext().report(enabled ? "Sky -> On" : "Sky -> Off");
            }
        };

        class OpTurnMoonWhite : public Interpreter::Opcode0
        {
        public:
            void execute(Interpreter::Runtime& runtime) override
            {
                MWBase::Environment::get().getWorld()->setMoonColour(false);
            }
        };

        class OpTurnMoonRed : public Interpreter::Opcode0
        {
        public:
            void execute(Interpreter::Runtime& runtime) override
            {
                MWBase::Environment::get().getWorld()->setMoonColour(true);
            }
        };

        class OpGetMasserPhase : public Interpreter::Opcode0
        {
        public:
            void execute(Interpreter::Runtime& runtime) override
            {
                runtime.push(MWBase::Environment::get().getWorld()->getMasserPhase());
            }
        };

        class OpGetSecundaPhase : public Interpreter::Opcode0
        {
        public:
            void execute(Interpreter::Runtime& runtime) override
            {
                runtime.push(MWBase::Environment::get().getWorld()->getSecundaPhase());
            }
        };

        class OpGetCurrentWeather : public Interpreter::Opcode0
        {
        public:
            void execute(Interpreter::Runtime& runtime) override
            {
                runtime.push(MWBase::Environment::get().getWorld()->getCurrentWeatherScriptId());
            }
        };

        class OpChangeWeather : public Interpreter::Opcode0
        {
        public:
            void execute(Interpreter::Runtime& runtime) override
            {
                ESM::RefId region = ESM::RefId::stringRefId(runtime.getStringLiteral(runtime[0].mInteger));
                runtime.pop();

                Interpreter::Type_Integer id = runtime[0].mInteger;
                runtime.pop();

                const ESM::Region* reg = MWBase::Environment::get().getESMStore()->get<ESM::Region>().search(region);
                if (reg)
                {
                    MWBase::Environment::get().getWorld()->changeWeather(region, id);
                    // OT3-83: only the region holder's sky is broadcast, so a script run on any
                    // other engine would be overwritten at the holder's next say. Note it; Lua
                    // forwards it to the holder (WorldWeatherScript).
                    MWMP::ScriptNote note;
                    note.mKind = "weather";
                    note.mRegion = region.getRefIdString();
                    note.mWeather = id;
                    MWMP::recordScriptNote(std::move(note));
                }
                else
                    runtime.getContext().report("Warning: Region \"" + region.getRefIdString() + "\" was not found");
            }
        };

        class OpModRegion : public Interpreter::Opcode1
        {
        public:
            void execute(Interpreter::Runtime& runtime, unsigned int arg0) override
            {
                std::string_view region{ runtime.getStringLiteral(runtime[0].mInteger) };
                runtime.pop();

                std::vector<uint8_t> chances;
                chances.reserve(10);
                while (arg0 > 0)
                {
                    chances.push_back(static_cast<uint8_t>(std::clamp(runtime[0].mInteger, 0, 100)));
                    runtime.pop();
                    arg0--;
                }

                MWBase::Environment::get().getWorld()->modRegion(ESM::RefId::stringRefId(region), chances);
                // OT3-83: endgame blight. The chances live only in this engine's WeatherManager;
                // note them so Lua relays them to the server, which saves and replays them.
                MWMP::ScriptNote note;
                note.mKind = "modregion";
                note.mRegion = std::string(region);
                note.mChances = std::move(chances);
                MWMP::recordScriptNote(std::move(note));
            }
        };

        void installOpcodes(Interpreter::Interpreter& interpreter)
        {
            interpreter.installSegment5<OpToggleSky>(Compiler::Sky::opcodeToggleSky);
            interpreter.installSegment5<OpTurnMoonWhite>(Compiler::Sky::opcodeTurnMoonWhite);
            interpreter.installSegment5<OpTurnMoonRed>(Compiler::Sky::opcodeTurnMoonRed);
            interpreter.installSegment5<OpGetMasserPhase>(Compiler::Sky::opcodeGetMasserPhase);
            interpreter.installSegment5<OpGetSecundaPhase>(Compiler::Sky::opcodeGetSecundaPhase);
            interpreter.installSegment5<OpGetCurrentWeather>(Compiler::Sky::opcodeGetCurrentWeather);
            interpreter.installSegment5<OpChangeWeather>(Compiler::Sky::opcodeChangeWeather);
            interpreter.installSegment3<OpModRegion>(Compiler::Sky::opcodeModRegion);
        }
    }
}
