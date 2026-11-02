#ifndef OPENMW_COMPONENTS_NIF_CLEANUP_HPP
#define OPENMW_COMPONENTS_NIF_CLEANUP_HPP

#include <cstddef>

namespace Nif
{
    struct NIFFile;

    /// What one cleanup pass removed. Used for logging and by the tests.
    struct CleanupStats
    {
        std::size_t mDegenerateTriangles = 0;
        std::size_t mEmptyShapes = 0;
        std::size_t mEmptyNodes = 0;
        std::size_t mRedundantProperties = 0;

        std::size_t total() const
        {
            return mDegenerateTriangles + mEmptyShapes + mEmptyNodes + mRedundantProperties;
        }
    };

    /// OT3-210: load-time mesh cleanup ("our MOP"), the automatable half of what the Morrowind
    /// Optimization Patch does by hand, written from scratch and applied to the player's own files.
    ///
    /// Runs on the parsed file BEFORE either consumer sees it (NifFileManager::get), so the
    /// renderer (nifosg) and the collision builder (nifbullet) read the same cleaned tree, and the
    /// browser engine and the native peer produce the same collision. Every decision is made with
    /// integer and exact-equality comparisons only -- no float arithmetic -- so the result cannot
    /// differ between wasm and x86-64.
    ///
    /// What it does, all of it invisible by construction:
    ///  - drops triangles that cannot be drawn or collided with: repeated vertex indices, indices
    ///    past the vertex array, or two corners at the exact same position (NiTriShapeData; shared
    ///    data is cleaned once);
    ///  - detaches NiTriShapes left with no triangles (no skin, controller, extra data or
    ///    collision object);
    ///  - detaches unnamed leaf NiNodes with nothing attached (no children, effects, controller,
    ///    extra data, collision object; not a bone);
    ///  - drops a node's property when the very same property record is already in effect from an
    ///    ancestor (texturing and controlled properties are left alone).
    /// Nodes are only removed from plain NiNode / RootCollisionNode parents (switch, LOD and other
    /// index-sensitive parents are never touched), and not at all in a file that has controllers,
    /// skins, particles or dynamic effects, any of which can point at a node from outside the tree.
    /// Only Morrowind-era files (version <= 4.0.0.2) are touched.
    ///
    /// Geometry merging under shared state is NOT done here: SceneManager's SceneUtil::Optimizer
    /// (MERGE_GEOMETRY, FLATTEN_STATIC_TRANSFORMS) and object paging already do it on the osg side.
    CleanupStats cleanupFile(NIFFile& file);
}

#endif
