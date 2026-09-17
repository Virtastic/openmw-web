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
    inline bool shouldAddTile(const TilePosition& changedTile, const TilePosition& playerTile, int maxTiles,
        std::span<const TilePosition> simAnchorTiles)
    {
        if (shouldAddTile(changedTile, playerTile, maxTiles))
            return true;
        for (const TilePosition& anchorTile : simAnchorTiles)
            if (shouldAddTile(changedTile, anchorTile, maxTiles))
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
