// Modified by Virtastic (https://virtastic.app) for the OpenMW-Web port, 2025-2026.
// See WASM_ADAPTATIONS.md at the repository root for details of the changes.
#include "navmeshmanager.hpp"

#include "debug.hpp"
#include "gettilespositions.hpp"
#include "makenavmesh.hpp"
#include "navmeshcacheitem.hpp"
#include "settings.hpp"
#include "settingsutils.hpp"
#include "waitconditiontype.hpp"

#include <chrono>

#include <components/debug/debuglog.hpp>
#include <components/esm/util.hpp>

#include <osg/io_utils>

#include <DetourNavMesh.h>

namespace
{
    /// Safely reset shared_ptr with definite underlying object destrutor call.
    /// Assuming there is another thread holding copy of this shared_ptr or weak_ptr to this shared_ptr.
    template <class T>
    bool resetIfUnique(std::shared_ptr<T>& ptr)
    {
        const std::weak_ptr<T> weak(ptr);
        ptr.reset();
        if (auto shared = weak.lock())
        {
            ptr = std::move(shared);
            return false;
        }
        return true;
    }
}

namespace DetourNavigator
{
    namespace
    {
        int getMaxRadius(int maxTiles)
        {
            return static_cast<int>(std::ceil(std::sqrt(static_cast<float>(maxTiles) / osg::PIf) + 1));
        }

        TilesPositionsRange makeRange(const TilePosition& center, int radius)
        {
            return TilesPositionsRange{
                .mBegin = center - TilePosition(radius, radius),
                .mEnd = center + TilePosition(radius + 1, radius + 1),
            };
        }

        osg::Vec2f getMinCellGridPosition(const osg::Vec2i& center, int offset, float cellSize)
        {
            const osg::Vec2i cell = center + osg::Vec2i(offset, offset);
            return osg::Vec2f(static_cast<float>(cell.x()) * cellSize, static_cast<float>(cell.y()) * cellSize);
        }

        TilesPositionsRange makeCellGridRange(
            const RecastSettings& settings, ESM::RefId worldspace, const CellGridBounds& bounds)
        {
            const float floatCellSize = static_cast<float>(ESM::getCellSize(worldspace));
            const osg::Vec2f min = getMinCellGridPosition(bounds.mCenter, -bounds.mHalfSize, floatCellSize);
            const osg::Vec2f max = getMinCellGridPosition(bounds.mCenter, bounds.mHalfSize + 1, floatCellSize);
            return TilesPositionsRange{
                .mBegin = getTilePosition(settings, toNavMeshCoordinates(settings, min)),
                .mEnd = getTilePosition(settings, toNavMeshCoordinates(settings, max)),
            };
        }

        TilesPositionsRange makeRange(const Settings& settings, ESM::RefId worldspace,
            const std::optional<CellGridBounds>& bounds, int radius, const TilePosition& center)
        {
            TilesPositionsRange result = makeRange(center, radius);
            if (bounds.has_value())
                result = getIntersection(result, makeCellGridRange(settings.mRecast, worldspace, *bounds));
            return result;
        }

        TilePosition toNavMeshTilePosition(const RecastSettings& settings, const osg::Vec3f& position)
        {
            return getTilePosition(settings, toNavMeshCoordinates(settings, position));
        }
    }

    NavMeshManager::NavMeshManager(const Settings& settings, std::unique_ptr<NavMeshDb>&& db)
        : mSettings(settings)
        , mMaxRadius(getMaxRadius(settings.mMaxTilesNumber))
        , mRecastMeshManager(settings.mRecast)
        , mOffMeshConnectionsManager(settings.mRecast)
        , mAsyncNavMeshUpdater(settings, mRecastMeshManager, mOffMeshConnectionsManager, std::move(db))
    {
    }

    void NavMeshManager::updateBounds(ESM::RefId worldspace, const std::optional<CellGridBounds>& cellGridBounds,
        const osg::Vec3f& playerPosition, const UpdateGuard* guard)
    {
        if (worldspace != mWorldspace)
        {
            mRecastMeshManager.setWorldspace(worldspace, guard);
            for (auto& [agent, cache] : mCache)
                cache = std::make_shared<GuardedNavMeshCacheItem>(++mGenerationCounter, mSettings);
            mWorldspace = worldspace;
        }

        const TilePosition playerTile = toNavMeshTilePosition(mSettings.mRecast, playerPosition);

        mCellGridBounds = cellGridBounds;
        setRange(playerTile, guard);
    }

    void NavMeshManager::setSimAnchorGrids(std::vector<CellGridBounds> grids)
    {
        if (grids == mSimAnchorGrids)
            return;
        mSimAnchorGrids = std::move(grids);
        // Force the next update() past its early-return: the player tile and the recast mesh
        // revision may both be unchanged while the set of grids we owe tiles to is not.
        mPlayerTile.reset();
    }

    // The range the recast mesh manager tracks and the navmesh is built for: the vanilla
    // player-centred range, widened to enclose every sim anchor's grid (backlog 479). The anchor
    // grids are also kept separately, because a bounding rectangle over anchors far apart covers
    // cells nobody loaded, and update() must not post jobs for those.
    TilesPositionsRange NavMeshManager::setRange(const TilePosition& playerTile, const UpdateGuard* guard)
    {
        const TilesPositionsRange playerRange
            = makeRange(mSettings, mWorldspace, mCellGridBounds, mMaxRadius, playerTile);
        TilesPositionsRange range = playerRange;
        mSimAnchorRanges.clear();
        mSimAnchorTiles.clear();
        for (const CellGridBounds& grid : mSimAnchorGrids)
        {
            const TilesPositionsRange gridRange = makeCellGridRange(mSettings.mRecast, mWorldspace, grid);
            mSimAnchorRanges.push_back(gridRange);
            // The grid's centre tile is the anchor's centre for the distance gate. A tile is
            // 435 u and a cell 18.8 tiles, so a 3x3 grid is 56 tiles across and no gate covers
            // it whole: the per-centre circle (shouldAddTile, backlog 483: 1024 / centres tiles,
            // radius 12.8 tiles = 5556 u with two centres) is drawn from the middle of the
            // anchored CELL, which it covers with a margin into the neighbours.
            mSimAnchorTiles.push_back((gridRange.mBegin + gridRange.mEnd) / 2);
            range = getUnion(range, gridRange);
        }
        mRecastMeshManager.setRange(range, guard);
        return playerRange;
    }

    bool NavMeshManager::addObject(const ObjectId id, const CollisionShape& shape, const btTransform& transform,
        const AreaType areaType, const UpdateGuard* guard)
    {
        return mRecastMeshManager.addObject(id, shape, transform, areaType, guard);
    }

    bool NavMeshManager::updateObject(
        const ObjectId id, const btTransform& transform, const AreaType areaType, const UpdateGuard* guard)
    {
        return mRecastMeshManager.updateObject(id, transform, areaType, guard);
    }

    void NavMeshManager::removeObject(const ObjectId id, const UpdateGuard* guard)
    {
        mRecastMeshManager.removeObject(id, guard);
    }

    void NavMeshManager::addWater(const osg::Vec2i& cellPosition, int cellSize, float level, const UpdateGuard* guard)
    {
        mRecastMeshManager.addWater(cellPosition, cellSize, level, guard);
    }

    void NavMeshManager::removeWater(const osg::Vec2i& cellPosition, const UpdateGuard* guard)
    {
        mRecastMeshManager.removeWater(cellPosition, guard);
    }

    void NavMeshManager::addHeightfield(
        const osg::Vec2i& cellPosition, int cellSize, const HeightfieldShape& shape, const UpdateGuard* guard)
    {
        mRecastMeshManager.addHeightfield(cellPosition, cellSize, shape, guard);
    }

    void NavMeshManager::removeHeightfield(const osg::Vec2i& cellPosition, const UpdateGuard* guard)
    {
        mRecastMeshManager.removeHeightfield(cellPosition, guard);
    }

    void NavMeshManager::addAgent(const AgentBounds& agentBounds)
    {
        auto cached = mCache.find(agentBounds);
        if (cached != mCache.end())
            return;
        mCache.emplace(agentBounds, std::make_shared<GuardedNavMeshCacheItem>(++mGenerationCounter, mSettings));
        mPlayerTile.reset();
        Log(Debug::Debug) << "cache add for agent=" << agentBounds;
    }

    bool NavMeshManager::reset(const AgentBounds& agentBounds)
    {
        const auto it = mCache.find(agentBounds);
        if (it == mCache.end())
            return true;
        if (!resetIfUnique(it->second))
            return false;
        mCache.erase(agentBounds);
        mPlayerTile.reset();
        return true;
    }

    void NavMeshManager::addOffMeshConnection(
        const ObjectId id, const osg::Vec3f& start, const osg::Vec3f& end, const AreaType areaType)
    {
        mOffMeshConnectionsManager.add(id, OffMeshConnection{ start, end, areaType });

        const auto startTilePosition = getTilePosition(mSettings.mRecast, start);
        const auto endTilePosition = getTilePosition(mSettings.mRecast, end);

        mRecastMeshManager.addChangedTile(startTilePosition, ChangeType::add);

        if (startTilePosition != endTilePosition)
            mRecastMeshManager.addChangedTile(endTilePosition, ChangeType::add);
    }

    void NavMeshManager::removeOffMeshConnections(const ObjectId id)
    {
        const auto changedTiles = mOffMeshConnectionsManager.remove(id);
        for (const auto& tile : changedTiles)
            mRecastMeshManager.addChangedTile(tile, ChangeType::update);
    }

    void NavMeshManager::update(const osg::Vec3f& playerPosition, const UpdateGuard* guard)
    {
        const TilePosition playerTile = toNavMeshTilePosition(mSettings.mRecast, playerPosition);
        if (mLastRecastMeshManagerRevision == mRecastMeshManager.getRevision() && mPlayerTile.has_value()
            && *mPlayerTile == playerTile)
            return;
        mLastRecastMeshManagerRevision = mRecastMeshManager.getRevision();
        mPlayerTile = playerTile;
        const TilesPositionsRange playerRange = setRange(playerTile, guard);
        const auto changedTiles = mRecastMeshManager.takeChangedTiles(guard);
        const TilesPositionsRange range = mRecastMeshManager.getLimitedObjectsRange();
        // The worker threads gate on the same anchor list this update() posts by; without it they
        // would drop every far anchor's job as "too far from player" the moment it was popped.
        mAsyncNavMeshUpdater.setSimAnchorTiles(mSimAnchorTiles);
        for (const auto& [agentBounds, cached] : mCache)
            update(agentBounds, playerTile, playerRange, range, cached, changedTiles);
    }

    void NavMeshManager::update(const AgentBounds& agentBounds, const TilePosition& playerTile,
        const TilesPositionsRange& playerRange, const TilesPositionsRange& range, const SharedNavMeshCacheItem& cached,
        const std::map<osg::Vec2i, ChangeType>& changedTiles)
    {
        std::map<osg::Vec2i, ChangeType> tilesToPost;
        const int maxTiles = mSettings.mMaxTilesNumber;
        for (const auto& [k, v] : changedTiles)
            if (shouldAddTile(k, playerTile, maxTiles, mSimAnchorTiles))
                tilesToPost.emplace(k, v);
        {
            const auto locked = cached->lockConst();
            const auto& navMesh = locked->getImpl();
            const auto visit = [&](const TilePosition& tile) {
                if (changedTiles.find(tile) != changedTiles.end() || locked->isEmptyTile(tile))
                    return;
                const bool shouldAdd = shouldAddTile(tile, playerTile, maxTiles, mSimAnchorTiles);
                const bool presentInNavMesh = navMesh.getTileAt(tile.x(), tile.y(), 0) != nullptr;
                if (shouldAdd && !presentInNavMesh)
                    tilesToPost.emplace(tile, ChangeType::add);
                else if (!shouldAdd && presentInNavMesh)
                    tilesToPost.emplace(tile, ChangeType::remove);
            };
            // `range` is the recast manager's (bounding) range clipped to where objects exist;
            // walk only the player's part of it and each anchor grid's part, never the empty
            // span between two far anchors (backlog 479). With no anchors playerRange already
            // encloses `range`, so this is the vanilla single walk. tilesToPost is a map, so a
            // tile two grids share is posted once.
            getTilesPositions(getIntersection(playerRange, range), visit);
            for (const TilesPositionsRange& anchorRange : mSimAnchorRanges)
                getTilesPositions(getIntersection(anchorRange, range), visit);
            locked->forEachTilePosition([&](const TilePosition& tile) {
                if (!shouldAddTile(tile, playerTile, maxTiles, mSimAnchorTiles))
                    tilesToPost.emplace(tile, ChangeType::remove);
            });
        }
        mAsyncNavMeshUpdater.post(agentBounds, cached, playerTile, mWorldspace, tilesToPost);
        Log(Debug::Debug) << "Cache update posted for agent=" << agentBounds << " playerTile=" << playerTile
                          << " recastMeshManagerRevision=" << mLastRecastMeshManagerRevision;
    }

    void NavMeshManager::wait(WaitConditionType waitConditionType, Loading::Listener* listener)
    {
        mAsyncNavMeshUpdater.wait(waitConditionType, listener);
    }

    SharedNavMeshCacheItem NavMeshManager::getNavMesh(const AgentBounds& agentBounds) const
    {
        return getCached(agentBounds);
    }

    std::map<AgentBounds, SharedNavMeshCacheItem> NavMeshManager::getNavMeshes() const
    {
        return mCache;
    }

    Stats NavMeshManager::getStats() const
    {
        return Stats{
            .mUpdater = mAsyncNavMeshUpdater.getStats(),
            .mRecast = mRecastMeshManager.getStats(),
        };
    }

    RecastMeshTiles NavMeshManager::getRecastMeshTiles() const
    {
        RecastMeshTiles result;
        getTilesPositions(mRecastMeshManager.getLimitedObjectsRange(), [&](const TilePosition& v) {
            if (auto mesh = mRecastMeshManager.getCachedMesh(mWorldspace, v))
                result.emplace(v, std::move(mesh));
        });
        return result;
    }

    SharedNavMeshCacheItem NavMeshManager::getCached(const AgentBounds& agentBounds) const
    {
        const auto cached = mCache.find(agentBounds);
        if (cached != mCache.end())
            return cached->second;
        return SharedNavMeshCacheItem();
    }
}
