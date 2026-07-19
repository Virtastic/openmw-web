// Added by Virtastic (https://virtastic.app) for the OpenMW-Web port, 2026.
// See WASM_ADAPTATIONS.md at the repository root for details.
#ifndef MWMP_LUABINDINGS_H
#define MWMP_LUABINDINGS_H

#include <sol/forward.hpp>

namespace MWLua
{
    struct Context;
}

namespace MWMP
{
    // "openmw.mp" package (registered for global, local/custom, player and menu contexts).
    sol::table initMPPackage(const MWLua::Context& context);
}

#endif // MWMP_LUABINDINGS_H
