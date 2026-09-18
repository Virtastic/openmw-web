#ifndef OPENMW_COMPONENTS_DETOURNAVIGATOR_MAKENAVMESH_H
#define OPENMW_COMPONENTS_DETOURNAVIGATOR_MAKENAVMESH_H

#include "recastmesh.hpp"
#include "tileposition.hpp"

#include <components/esm/refid.hpp>

#include <memory>
#include <span>

class dtNavMesh;
struct rcConfig;

namespace DetourNavigator
{
    struct Settings;
    struct PreparedNavMeshData;
    struct NavMeshData;
    struct OffMeshConnection;
    struct AgentBounds;
    struct RecastSettings;

    inline float getLength(const osg::Vec2i& value)
    {
        return std::sqrt(float(osg::square(value.x()) + osg::square(value.y())));
    }

    inline float getDistance(const TilePosition& lhs, const TilePosition& rhs)
    {
        return getLength(lhs - rhs);
    }

    inline bool shouldAddTile(const TilePosition& changedTile, const TilePosition& playerTile, int maxTiles)
    {
        const auto expectedTilesCount = std::ceil(osg::PI * osg::square(getDistance(changedTile, playerTile)));
        return expectedTilesCount <= maxTiles;
    }

    // MP (backlog 479): the sim peer keeps a 3x3 cell grid alive around every SIM ANCHOR, not
    // just around its own player (the dummy), but every "is this tile worth having" gate above
    // measured from the dummy alone: a tile in an anchored cell 10+ cells away failed it, was
    // never generated (or was evicted as "too far from player"), and the AI there had no navmesh
    // -- s166's kwama forager crawled 422 -> 207 u in 15 s on a straight line into terrain
    // instead of chasing. A tile is wanted if it is near the player OR near any anchor. With no
    // anchors (single player, the browser client) this is exactly the old gate.
    //
    // THE BUDGET IS SHARED (backlog 483). maxTiles is also the dtNavMesh's tile POOL
    // (initEmptyNavMesh: params.maxTiles = mMaxTilesNumber, 1024 = all the 22-bit id space
    // leaves beside 4096 polys), and the gate above is calibrated to fill it from ONE centre:
    // pi * 18.05^2 admits 1033 tiles, a tile being 435 u (64 * 0.2 / 0.0294), so one circle is
    // ~1.9 cells across and every exterior tile in it is non-empty (terrain + water). Gating
    // each anchor with the full 1024 too asked for 2066 tiles from a 1024 pool: the dummy's
    // circle, queued nearest-the-player-first, took every slot, the anchor's adds failed with
    // DT_OUT_OF_MEMORY, and the AI two cells out had a navmesh with no tile under it -- which
    // is WORSE than no navmesh: PathFinder::buildPath only walks a straight line on
    // NavMeshNotFound, StartPolygonNotFound gives an empty path, and AiCombat answers an empty
    // path with ActionFlee, idle until the target comes within its trigger distance. #119 s166:
    // the scrib (Speed 13 = 43 u/s) covered 9 u in 30 s; #114/#115's forager sat at the same
    // x,y in both runs. Split the pool evenly between the centres instead: two centres get
    // 512 each (509 tiles, radius 12.8 tiles = 5556 u around the anchor CELL's centre, so the
    // whole anchored cell plus ~1400 u of its neighbours), three 341, four 256 (3929 u, a cell
    // minus its corners). Raise the pool on the peer with `max polygons per tile = 2048` +
    // `max tiles number = 2048` when four clusters are the norm.
    inline bool shouldAddTile(const TilePosition& changedTile, const TilePosition& playerTile, int maxTiles,
        std::span<const TilePosition> simAnchorTiles)
    {
        const int perCentre = maxTiles / static_cast<int>(1 + simAnchorTiles.size());
        if (shouldAddTile(changedTile, playerTile, perCentre))
            return true;
        for (const TilePosition& anchorTile : simAnchorTiles)
            if (shouldAddTile(changedTile, anchorTile, perCentre))
                return true;
        return false;
    }

    inline bool isEmpty(const RecastMesh& recastMesh)
    {
        return recastMesh.getMesh().getIndices().empty() && recastMesh.getWater().empty()
            && recastMesh.getHeightfields().empty() && recastMesh.getFlatHeightfields().empty();
    }

    std::unique_ptr<PreparedNavMeshData> prepareNavMeshTileData(const RecastMesh& recastMesh, ESM::RefId worldspace,
        const TilePosition& tilePosition, const AgentBounds& agentBounds, const RecastSettings& settings);

    NavMeshData makeNavMeshTileData(const PreparedNavMeshData& data,
        std::span<const OffMeshConnection> offMeshConnections, const AgentBounds& agentBounds, const TilePosition& tile,
        const RecastSettings& settings);

    void initEmptyNavMesh(const Settings& settings, dtNavMesh& navMesh);

    bool isSupportedAgentBounds(const RecastSettings& settings, const AgentBounds& agentBounds);
}

#endif
