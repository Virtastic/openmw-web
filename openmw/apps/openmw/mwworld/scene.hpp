#ifndef GAME_MWWORLD_SCENE_H
#define GAME_MWWORLD_SCENE_H

#include <osg/Vec2i>
#include <osg/Vec4i>
#include <osg/ref_ptr>

#include "positioncellgrid.hpp"
#include "ptr.hpp"

#include <memory>
#include <optional>
#include <set>
#include <vector>

#include <components/esm/exteriorcelllocation.hpp>
#include <components/misc/constants.hpp>

namespace osg
{
    class Vec3f;
    class Stats;
}

namespace ESM
{
    struct Position;
}

namespace Files
{
    class Collections;
}

namespace Loading
{
    class Listener;
}

namespace DetourNavigator
{
    struct Navigator;
    class UpdateGuard;
}

namespace MWRender
{
    class SkyManager;
    class RenderingManager;
}

namespace MWPhysics
{
    class PhysicsSystem;
}

namespace SceneUtil
{
    class WorkItem;
}

namespace MWWorld
{
    class Player;
    class CellStore;
    class CellPreloader;
    class World;

    enum class RotationOrder
    {
        direct,
        inverse
    };

    class Scene
    {
    public:
        using CellStoreCollection = std::set<CellStore*, std::less<>>;

    private:
        struct ChangeCellGridRequest
        {
            osg::Vec3f mPosition;
            ESM::ExteriorCellLocation mCellIndex;
            bool mChangeEvent;
        };

        CellStore* mCurrentCell; // the cell the player is in
        CellStoreCollection mActiveCells;
        bool mCellChanged;
        bool mCellLoaded = false;
        MWWorld::World& mWorld;
        MWPhysics::PhysicsSystem* mPhysics;
        MWRender::RenderingManager& mRendering;
        DetourNavigator::Navigator& mNavigator;
        std::unique_ptr<CellPreloader> mPreloader;
        float mCellLoadingThreshold;
        float mPreloadDistance;
        bool mPreloadEnabled;

        bool mPreloadExteriorGrid;
        bool mPreloadDoors;
        bool mPreloadFastTravel;
        float mPredictionTime;
        float mLowestPoint;

        int mHalfGridSize = Constants::CellGridRadius;

        osg::Vec3f mLastPlayerPos;

        std::vector<ESM::RefNum> mPagedRefs;

        std::vector<osg::ref_ptr<SceneUtil::WorkItem>> mWorkItems;

        std::optional<ChangeCellGridRequest> mChangeCellGridRequest;

        void insertCell(CellStore& cell, Loading::Listener* loadingListener,
            const DetourNavigator::UpdateGuard* navigatorUpdateGuard);

        osg::Vec2i mCurrentGridCenter;

        // MP SIMULATION ANCHORS. Vanilla keeps ONE grid of active cells, centred on the player,
        // and unloads everything else — so a headless sim peer could only ever simulate the one
        // place its avatar stood. Serving players spread across the world then meant one ~450 MB
        // peer process PER occupied cell, which does not scale past a handful of players.
        //
        // These are extra centres the server asks this process to keep active. Cells within
        // mHalfGridSize of ANY anchor stay loaded; actors near any anchor keep processing. The
        // marginal cost of an anchor is that region's cells (meshes, collision, navmesh) rather
        // than a whole second engine, because the ESM store and every subsystem are shared.
        // Empty of anchors — every normal client — this is exactly vanilla behaviour.
        //
        // TWO REPRESENTATIONS, ONE SOURCE. The server sends WORLD POSITIONS (each player's
        // live pose). mSimAnchorPositions keeps them raw for the mechanics range checks —
        // 7168 units around each player, exactly what a single-player client gets. The grid
        // coordinates derived from them drive cell LOADING (mSimAnchors), and only a change
        // in the DERIVED set re-runs the grid: positions move every tick, and rebuilding the
        // grid every resend for no reason is the one expensive mistake this split prevents.
        // The old cell-centre form covered the anchored cell but reached only ~3072 units
        // into any neighbour (centre-to-corner is 5793 against a 7168 range), leaving a ring
        // of loaded-but-frozen cells — the same bug class the anchors exist to fix.
        std::vector<osg::Vec3f> mSimAnchorPositions;
        std::vector<osg::Vec2i> mSimAnchors;

        // Interiors held for the server, by cell name. An interior has NO grid coordinate, so
        // it cannot be expressed in mSimAnchors — which is why a peer used to be able to
        // simulate an interior only by standing in it, and why Morrowind's opening (entirely
        // indoors) had no simulator at all unless the peer happened to be in that exact room.
        // These are kept loaded and their actors keep processing regardless of where this
        // process's own player stands, exactly like an exterior anchor.
        std::vector<ESM::RefId> mSimAnchorInteriors;

        // Load and unload cells as necessary to create a cell grid with "X" and "Y" in the center
        void changeCellGrid(const osg::Vec3f& pos, ESM::ExteriorCellLocation playerCellIndex, bool changeEvent = true);

        void requestChangeCellGrid(const osg::Vec3f& position, const osg::Vec2i& cell, bool changeEvent = true);

        void preloadCells(float dt);
        void preloadTeleportDoorDestinations(const osg::Vec3f& playerPos, const osg::Vec3f& predictedPos);
        void preloadExteriorGrid(const osg::Vec3f& playerPos, const osg::Vec3f& predictedPos);
        void preloadFastTravelDestinations(
            const osg::Vec3f& playerPos, std::vector<PositionCellGrid>& exteriorPositions);
        void preloadCellWithSurroundings(MWWorld::CellStore& cell);
        void preloadCell(MWWorld::CellStore& cell);
        void preloadTerrain(const osg::Vec3f& pos, ESM::RefId worldspace, bool sync = false);

        osg::Vec4i gridCenterToBounds(const osg::Vec2i& centerCell) const;
        osg::Vec2i getNewGridCenter(const osg::Vec3f& pos, const osg::Vec2i* currentGridCenter = nullptr) const;

        void unloadCell(CellStore* cell, const DetourNavigator::UpdateGuard* navigatorUpdateGuard);
        void loadCell(CellStore& cell, Loading::Listener* loadingListener, bool respawn, const osg::Vec3f& position,
            const DetourNavigator::UpdateGuard* navigatorUpdateGuard);

    public:
        /// Extra simulation anchors to keep active, in addition to the player's own grid.
        /// Server-driven (the sim peer's world server sends the list); empty for a real
        /// client. Exteriors are WORLD POSITIONS (players' live poses); `interiors` are held
        /// by name — an interior has no grid coordinate to anchor on.
        void setSimAnchors(
            const std::vector<osg::Vec3f>& anchors, const std::vector<ESM::RefId>& interiors = {});

        /// True when `cell` is an interior this process is holding for the server. Actors there
        /// must keep processing however far the local player is, because "distance" is
        /// meaningless across a door.
        bool isAnchoredInterior(const MWWorld::CellStore* cell) const;

        /// True when `cell` is within the active grid of the player or any simulation anchor.
        bool isWithinActiveGrids(int x, int y) const;

        /// World-space positions of the simulation anchors, for range checks in mechanics.
        std::vector<osg::Vec3f> getSimAnchorPositions() const;

        Scene(MWWorld::World& world, MWRender::RenderingManager& rendering, MWPhysics::PhysicsSystem* physics,
            DetourNavigator::Navigator& navigator);

        ~Scene();

        void reloadTerrain();

        void playerMoved(const osg::Vec3f& pos);

        void changePlayerCell(CellStore& newCell, const ESM::Position& position, bool adjustPlayerPos);

        CellStore* getCurrentCell();

        const CellStoreCollection& getActiveCells() const;

        bool hasCellChanged() const;
        ///< Has the set of active cells changed, since the last frame?

        bool hasCellLoaded() const { return mCellLoaded; }

        void resetCellLoaded() { mCellLoaded = false; }

        void changeToInteriorCell(
            std::string_view cellName, const ESM::Position& position, bool adjustPlayerPos, bool changeEvent = true);
        ///< Move to interior cell.
        /// @param changeEvent Set cellChanged flag?

        void changeToExteriorCell(
            const ESM::RefId& extCellId, const ESM::Position& position, bool adjustPlayerPos, bool changeEvent = true);
        ///< Move to exterior cell.
        /// @param changeEvent Set cellChanged flag?

        void clear();
        ///< Change into a void

        void markCellAsUnchanged();

        void update(float duration);

        void addObjectToScene(const Ptr& ptr);
        ///< Add an object that already exists in the world model to the scene.

        void removeObjectFromScene(const Ptr& ptr, bool keepActive = false);
        ///< Remove an object from the scene, but not from the world model.

        void addPostponedPhysicsObjects();

        void removeFromPagedRefs(const Ptr& ptr);

        bool isPagedRef(const Ptr& ptr) const;

        void updateObjectRotation(const Ptr& ptr, RotationOrder order);
        void updateObjectScale(const Ptr& ptr);

        bool isCellActive(const CellStore& cell);

        void preload(const std::string& mesh, bool useAnim = false);

        void testExteriorCells();
        void testInteriorCells();

        void reportStats(unsigned int frameNumber, osg::Stats& stats) const;
    };
}

#endif
