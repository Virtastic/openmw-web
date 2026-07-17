# Modified by Virtastic (https://virtastic.app) for the OpenMW-Web port, 2025-2026.
# See WASM_ADAPTATIONS.md at the repository root for details of the changes.
# Escape hatch for cross-compilation (emscripten/WASM): the try_compile below links a standalone
# pthread executable, which is flaky under emscripten even though the linked Bullet IS double
# precision. When we already know the precision (prebuilt dep stack), skip the probe.
if(DEFINED OPENMW_ASSUME_BULLET_DOUBLE_PRECISION)
    set(HAS_DOUBLE_PRECISION_BULLET ${OPENMW_ASSUME_BULLET_DOUBLE_PRECISION})
    message(STATUS "Bullet double precision assumed (OPENMW_ASSUME_BULLET_DOUBLE_PRECISION=${OPENMW_ASSUME_BULLET_DOUBLE_PRECISION})")
    return()
endif()

set(TMP_ROOT ${CMAKE_BINARY_DIR}/try-compile)
file(MAKE_DIRECTORY ${TMP_ROOT})

file(WRITE ${TMP_ROOT}/checkbullet.cpp
"
#include <BulletCollision/CollisionShapes/btSphereShape.h>
int main(int argc, char** argv)
{
    btSphereShape shape(1.0);
    btScalar mass(1.0);
    btVector3 inertia;
    shape.calculateLocalInertia(mass, inertia);
    return 0;
}
")

message(STATUS "Checking if Bullet uses double precision")

try_compile(RESULT_VAR
    ${TMP_ROOT}/temp
    ${TMP_ROOT}/checkbullet.cpp
    COMPILE_DEFINITIONS "-DBT_USE_DOUBLE_PRECISION"
    LINK_LIBRARIES ${BULLET_LIBRARIES}
    CMAKE_FLAGS  "-DINCLUDE_DIRECTORIES=${BULLET_INCLUDE_DIRS}"
    )
set(HAS_DOUBLE_PRECISION_BULLET ${RESULT_VAR})
