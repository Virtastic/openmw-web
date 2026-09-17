#ifndef OPENMW_COMPONENTS_DETOURNAVIGATOR_NAVMESHMANAGER_H
#define OPENMW_COMPONENTS_DETOURNAVIGATOR_NAVMESHMANAGER_H

#include "agentbounds.hpp"
#include "asyncnavmeshupdater.hpp"
#include "cellgridbounds.hpp"
#include "heightfieldshape.hpp"
#include "offmeshconnectionsmanager.hpp"
#include "recastmeshtiles.hpp"
#include "waitconditiontype.hpp"

#include <osg/Vec3f>

#include <map>
#include <memory>
#include <vector>

class dtNavMesh;

namespace DetourNavigator
{
    class NavMeshManager
    {
    public:
        explicit NavMeshManager(const Settings& settings, std::unique_ptr<NavMeshDb>&& db);

        ScopedUpdateGuard makeUpdateGuard() { return mRecastMeshManager.makeUpdateGuard(); }

        void updateBounds(ESM::RefId worldspace, const std::optional<CellGridBounds>& cellGridBounds,
            const osg::Vec3f& playerPosition, const UpdateGuard* guard);

        // MP (backlog 479): extra cell grids to keep navmesh for, one per sim anchor the scene
        // holds loaded. Takes effect on the next updateBounds/update. Empty in single player.
        void setSimAnchorGrids(std::vector<CellGridBounds> grids);

        bool addObject(const ObjectId id, const CollisionShape& shape, const btTransform& transform,
            const AreaType areaType, const UpdateGuard* guard);

        bool updateObject(ObjectId id, const btTransform& transform, AreaType areaType, const UpdateGuard* guard);

        void removeObject(const ObjectId id, const UpdateGuard* guard);

        void addAgent(const AgentBounds& agentBounds);

        void addWater(const osg::Vec2i& cellPosition, int cellSize, float level, const UpdateGuard* guard);

        void removeWater(const osg::Vec2i& cellPosition, const UpdateGuard* guard);

        void addHeightfield(
            const osg::Vec2i& cellPosition, int cellSize, const HeightfieldShape& shape, const UpdateGuard* guard);

        void removeHeightfield(const osg::Vec2i& cellPosition, const UpdateGuard* guard);

        bool reset(const AgentBounds& agentBounds);

        void addOffMeshConnection(
            const ObjectId id, const osg::Vec3f& start, const osg::Vec3f& end, const AreaType areaType);

        void removeOffMeshConnections(const ObjectId id);

        void update(const osg::Vec3f& playerPosition, const UpdateGuard* guard);

        void wait(WaitConditionType waitConditionType, Loading::Listener* listener);

        SharedNavMeshCacheItem getNavMesh(const AgentBounds& agentBounds) const;

        std::map<AgentBounds, SharedNavMeshCacheItem> getNavMeshes() const;

        Stats getStats() const;

        RecastMeshTiles getRecastMeshTiles() const;

    private:
        const Settings& mSettings;
        const int mMaxRadius;
        ESM::RefId mWorldspace;
        std::optional<CellGridBounds> mCellGridBounds;
        std::vector<CellGridBounds> mSimAnchorGrids;
        std::vector<TilesPositionsRange> mSimAnchorRanges;
        std::vector<TilePosition> mSimAnchorTiles;
        TileCachedRecastMeshManager mRecastMeshManager;
        OffMeshConnectionsManager mOffMeshConnectionsManager;
        AsyncNavMeshUpdater mAsyncNavMeshUpdater;
        std::map<AgentBounds, SharedNavMeshCacheItem> mCache;
        std::size_t mGenerationCounter = 0;
        std::optional<TilePosition> mPlayerTile;
        std::size_t mLastRecastMeshManagerRevision = 0;

        inline SharedNavMeshCacheItem getCached(const AgentBounds& agentBounds) const;

        inline TilesPositionsRange setRange(const TilePosition& playerTile, const UpdateGuard* guard);

        inline void update(const AgentBounds& agentBounds, const TilePosition& playerTile,
            const TilesPositionsRange& playerRange, const TilesPositionsRange& range,
            const SharedNavMeshCacheItem& cached, const std::map<osg::Vec2i, ChangeType>& changedTiles);
    };
}

#endif
