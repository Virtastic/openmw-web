#include "player.hpp"

#include <stdexcept>

#include <components/debug/debuglog.hpp>

#include <components/esm/defs.hpp>
#include <components/esm3/actoridconverter.hpp>
#include <components/esm3/esmreader.hpp>
#include <components/esm3/esmwriter.hpp>
#include <components/esm3/loadbsgn.hpp>
#include <components/esm3/loadmgef.hpp>
#include <components/esm3/player.hpp>
#include <components/fallback/fallback.hpp>

#include "../mwworld/esmstore.hpp"
#include "../mwworld/inventorystore.hpp"
#include "../mwworld/magiceffects.hpp"
#include "../mwworld/worldmodel.hpp"

#include "../mwbase/environment.hpp"
#include "../mwbase/luamanager.hpp"
#include "../mwbase/mechanicsmanager.hpp"
#include "../mwbase/windowmanager.hpp"
#include "../mwbase/world.hpp"

#include "../mwmechanics/movement.hpp"
#include "../mwmechanics/actorutil.hpp"
#include "../mwmechanics/npcstats.hpp"
#include "../mwmechanics/spellutil.hpp"

#include "../mwrender/camera.hpp"
#include "../mwrender/renderingmanager.hpp"

#include "cellstore.hpp"
#include "class.hpp"
#include "ptr.hpp"

namespace MWWorld
{
    namespace
    {
        ESM::CellRef makePlayerCellRef()
        {
            ESM::CellRef result;
            result.blank();
            result.mRefID = ESM::RefId::stringRefId("Player");
            return result;
        }
    }

    Player::Player(const ESM::NPC* player)
        : mPlayer(makePlayerCellRef(), player)
        , mCellStore(nullptr)
        , mLastKnownExteriorPosition(0, 0, 0)

        , mTeleported(false)
        , mCurrentCrimeId(-1)
        , mPaidCrimeId(-1)
    {
        ESM::Position playerPos = mPlayer.mData.getPosition();
        playerPos.pos[0] = playerPos.pos[1] = playerPos.pos[2] = 0;
        mPlayer.mData.setPosition(playerPos);
    }

    void Player::set(const ESM::NPC* player)
    {
        mPlayer.mBase = player;
    }

    void Player::setCell(MWWorld::CellStore* cellStore)
    {
        mCellStore = cellStore;
    }

    MWWorld::Ptr Player::getPlayer()
    {
        MWWorld::Ptr ptr(&mPlayer, mCellStore);
        return ptr;
    }

    MWWorld::ConstPtr Player::getConstPlayer() const
    {
        MWWorld::ConstPtr ptr(&mPlayer, mCellStore);
        return ptr;
    }

    void Player::setBirthSign(const ESM::RefId& sign)
    {
        mSign = sign;
    }

    const ESM::RefId& Player::getBirthSign() const
    {
        return mSign;
    }

    void Player::setDrawState(MWMechanics::DrawState state)
    {
        MWWorld::Ptr ptr = getPlayer();
        ptr.getClass().getNpcStats(ptr).setDrawState(state);
    }

    void Player::yaw(float yaw)
    {
        MWWorld::Ptr ptr = getPlayer();
        ptr.getClass().getMovementSettings(ptr).mRotation[2] += yaw;
    }
    void Player::pitch(float pitch)
    {
        MWWorld::Ptr ptr = getPlayer();
        ptr.getClass().getMovementSettings(ptr).mRotation[0] += pitch;
    }
    void Player::roll(float roll)
    {
        MWWorld::Ptr ptr = getPlayer();
        ptr.getClass().getMovementSettings(ptr).mRotation[1] += roll;
    }

    MWMechanics::DrawState Player::getDrawState()
    {
        MWWorld::Ptr ptr = getPlayer();
        return ptr.getClass().getNpcStats(ptr).getDrawState();
    }

    void Player::activate()
    {
        if (MWBase::Environment::get().getWindowManager()->isGuiMode())
            return;

        MWWorld::Ptr player = getPlayer();
        const MWMechanics::NpcStats& playerStats = player.getClass().getNpcStats(player);
        if (playerStats.isParalyzed() || playerStats.getKnockedDown() || playerStats.isDead())
            return;

        MWWorld::Ptr toActivate = MWBase::Environment::get().getWorld()->getFocusObject();

        if (toActivate.isEmpty())
            return;

        if (!toActivate.getClass().hasToolTip(toActivate))
            return;

        MWBase::Environment::get().getLuaManager()->objectActivated(toActivate, player);
    }

    bool Player::wasTeleported() const
    {
        return mTeleported;
    }

    void Player::setTeleported(bool teleported)
    {
        mTeleported = teleported;
    }

    void Player::setJumping(bool jumping)
    {
        getPlayer().getClass().getNpcStats(getPlayer()).setJumping(jumping);
    }

    bool Player::getJumping() const
    {
        // Class::getNpcStats takes a Ptr; these reads mutate nothing.
        const MWWorld::Ptr player = const_cast<Player*>(this)->getPlayer();
        return player.getClass().getNpcStats(player).getJumping();
    }

    bool Player::isInCombat()
    {
        return MWBase::Environment::get().getMechanicsManager()->getActorsFighting(getPlayer()).size() != 0;
    }

    bool Player::enemiesNearby()
    {
        return MWBase::Environment::get().getMechanicsManager()->getEnemiesNearby(getPlayer()).size() != 0;
    }

    void Player::markPosition(CellStore* markedCell, const ESM::Position& markedPosition)
    {
        MWMechanics::NpcStats& stats = getPlayer().getClass().getNpcStats(getPlayer());
        if (markedCell != nullptr)
            stats.setMarkedPosition(markedCell->getCell()->getId(), markedPosition);
        else
            stats.clearMarkedPosition();
    }

    void Player::getMarkedPosition(CellStore*& markedCell, ESM::Position& markedPosition) const
    {
        const MWWorld::Ptr player = const_cast<Player*>(this)->getPlayer();
        const MWMechanics::NpcStats& stats = player.getClass().getNpcStats(player);
        markedCell = nullptr;
        if (stats.getMarkedCell().empty())
            return;
        markedCell = MWBase::Environment::get().getWorldModel()->findCell(stats.getMarkedCell());
        if (markedCell != nullptr)
            markedPosition = stats.getMarkedPosition();
    }

    void Player::clear()
    {
        ESM::CellRef cellRef;
        cellRef.blank();
        cellRef.mRefID = ESM::RefId::stringRefId("Player");
        cellRef.mRefNum = mPlayer.mRef.getRefNum();
        mPlayer = LiveCellRef<ESM::NPC>(cellRef, mPlayer.mBase);
        mCellStore = nullptr;
        mSign = ESM::RefId();
        mTeleported = false;
        mCurrentCrimeId = -1;
        mPreviousItems.clear();
        mLastKnownExteriorPosition = osg::Vec3f(0, 0, 0);
        // The per-character state that used to be reset here (mark, werewolf snapshot,
        // jumping, paid crime id) lives in NpcStats now, and the LiveCellRef rebuild above
        // already gave the player a fresh one.
    }

    void Player::write(ESM::ESMWriter& writer, Loading::Listener& progress) const
    {
        ESM::Player player;

        mPlayer.save(player.mObject);
        player.mCellId = mCellStore->getCell()->getId();

        const MWWorld::Ptr playerPtr = const_cast<Player*>(this)->getPlayer();
        const MWMechanics::NpcStats& stats = playerPtr.getClass().getNpcStats(playerPtr);

        player.mCurrentCrimeId = mCurrentCrimeId;
        player.mPaidCrimeId = stats.getPaidCrimeId();

        player.mBirthsign = mSign;

        player.mLastKnownExteriorPosition[0] = mLastKnownExteriorPosition.x();
        player.mLastKnownExteriorPosition[1] = mLastKnownExteriorPosition.y();
        player.mLastKnownExteriorPosition[2] = mLastKnownExteriorPosition.z();

        if (!stats.getMarkedCell().empty())
        {
            player.mHasMark = true;
            player.mMarkedPosition = stats.getMarkedPosition();
            player.mMarkedCell = stats.getMarkedCell();
        }
        else
            player.mHasMark = false;

        const auto& saveAttributes = const_cast<MWMechanics::NpcStats&>(stats).werewolfSaveAttributes();
        const auto& saveSkills = const_cast<MWMechanics::NpcStats&>(stats).werewolfSaveSkills();
        for (size_t i = 0; i < saveAttributes.size(); ++i)
            player.mSaveAttributes[i] = saveAttributes[i];
        for (size_t i = 0; i < saveSkills.size(); ++i)
            player.mSaveSkills[i] = saveSkills[i];

        player.mPreviousItems = mPreviousItems;

        writer.startRecord(ESM::REC_PLAY);
        player.save(writer);
        writer.endRecord(ESM::REC_PLAY);
    }

    bool Player::readRecord(ESM::ESMReader& reader, uint32_t type)
    {
        if (type == ESM::REC_PLAY)
        {
            ESM::Player player;
            player.load(reader);

            if (!mPlayer.checkState(player.mObject))
            {
                // this is the one object we can not silently drop.
                throw std::runtime_error("invalid player state record (object state)");
            }
            if (reader.getFormatVersion() <= ESM::MaxClearModifiersFormatVersion)
                convertMagicEffects(
                    player.mObject.mCreatureStats, player.mObject.mInventory, &player.mObject.mNpcStats);
            else if (reader.getFormatVersion() <= ESM::MaxOldCreatureStatsFormatVersion)
            {
                convertStats(player.mObject.mCreatureStats);
                convertEnchantmentSlots(player.mObject.mCreatureStats, player.mObject.mInventory);
            }
            else if (reader.getFormatVersion() <= ESM::MaxActiveSpellSlotIndexFormatVersion)
                convertEnchantmentSlots(player.mObject.mCreatureStats, player.mObject.mInventory);

            if (!player.mObject.mEnabled)
            {
                Log(Debug::Warning) << "Warning: Savegame attempted to disable the player.";
                player.mObject.mEnabled = true;
            }

            MWBase::Environment::get().getWorldModel()->deregisterLiveCellRef(mPlayer);
            mPlayer.load(player.mObject);
            MWBase::Environment::get().getWorldModel()->registerPtr(getPlayer());
            if (reader.mActorIdConverter)
                reader.mActorIdConverter->mMappings.emplace(
                    player.mObject.mCreatureStats.mActorId, mPlayer.mRef.getRefNum());

            MWMechanics::NpcStats& stats = getPlayer().getClass().getNpcStats(getPlayer());
            auto& saveAttributes = stats.werewolfSaveAttributes();
            auto& saveSkills = stats.werewolfSaveSkills();
            for (size_t i = 0; i < saveAttributes.size(); ++i)
                saveAttributes[i] = player.mSaveAttributes[i];
            for (size_t i = 0; i < saveSkills.size(); ++i)
                saveSkills[i] = player.mSaveSkills[i];

            if (player.mObject.mNpcStats.mIsWerewolf)
            {
                if (reader.getFormatVersion() <= ESM::MaxOldSkillsAndAttributesFormatVersion)
                {
                    MWMechanics::applyWerewolfStats(getPlayer());
                    if (player.mSetWerewolfAcrobatics)
                        MWBase::Environment::get().getMechanicsManager()->applyWerewolfAcrobatics(getPlayer());
                }
            }

            getPlayer().getClass().getCreatureStats(getPlayer()).getAiSequence().clear();

            MWBase::World& world = *MWBase::Environment::get().getWorld();

            mCellStore = MWBase::Environment::get().getWorldModel()->findCell(player.mCellId);
            if (mCellStore == nullptr)
                Log(Debug::Warning) << "Player cell " << player.mCellId << " no longer exists";

            if (!player.mBirthsign.empty())
            {
                const ESM::BirthSign* sign = world.getStore().get<ESM::BirthSign>().search(player.mBirthsign);
                if (!sign)
                    throw std::runtime_error("invalid player state record (birthsign does not exist)");
            }

            mCurrentCrimeId = player.mCurrentCrimeId;
            stats.setPaidCrimeId(player.mPaidCrimeId);

            mSign = player.mBirthsign;

            mLastKnownExteriorPosition.x() = player.mLastKnownExteriorPosition[0];
            mLastKnownExteriorPosition.y() = player.mLastKnownExteriorPosition[1];
            mLastKnownExteriorPosition.z() = player.mLastKnownExteriorPosition[2];

            if (player.mHasMark)
            {
                if (!world.getStore().get<ESM::Cell>().search(player.mMarkedCell))
                    player.mHasMark = false; // drop mark silently
            }

            if (player.mHasMark)
            {
                stats.setMarkedPosition(player.mMarkedCell, player.mMarkedPosition);
            }
            else
            {
                stats.clearMarkedPosition();
            }

            mTeleported = false;

            mPreviousItems = player.mPreviousItems;

            return true;
        }

        return false;
    }

    int Player::getNewCrimeId()
    {
        return ++mCurrentCrimeId;
    }

    void Player::recordCrimeId()
    {
        getPlayer().getClass().getNpcStats(getPlayer()).setPaidCrimeId(mCurrentCrimeId);
    }

    int Player::getCrimeId() const
    {
        const MWWorld::Ptr player = const_cast<Player*>(this)->getPlayer();
        return player.getClass().getNpcStats(player).getPaidCrimeId();
    }

    void Player::setPreviousItem(const ESM::RefId& boundItemId, const ESM::RefId& previousItemId)
    {
        mPreviousItems[boundItemId] = previousItemId;
    }

    ESM::RefId Player::getPreviousItem(const ESM::RefId& boundItemId)
    {
        return mPreviousItems[boundItemId];
    }

    void Player::erasePreviousItem(const ESM::RefId& boundItemId)
    {
        mPreviousItems.erase(boundItemId);
    }

    void Player::setSelectedSpell(const ESM::RefId& spellId)
    {
        Ptr player = getPlayer();
        InventoryStore& store = player.getClass().getInventoryStore(player);
        store.setSelectedEnchantItem(store.end());
        int castChance = int(MWMechanics::getSpellSuccessChance(spellId, player));
        MWBase::Environment::get().getWindowManager()->setSelectedSpell(spellId, castChance);
        MWBase::Environment::get().getWindowManager()->updateSpellWindow();
    }

    void Player::update()
    {
        auto player = getPlayer();
        const auto world = MWBase::Environment::get().getWorld();
        const auto rendering = world->getRenderingManager();
        auto& store = world->getStore();
        auto& playerClass = player.getClass();
        const auto windowMgr = MWBase::Environment::get().getWindowManager();

        if (player.getCell()->isExterior())
        {
            ESM::Position pos = player.getRefData().getPosition();
            setLastKnownExteriorPosition(pos.asVec3());
        }

        bool isWerewolf = playerClass.getNpcStats(player).isWerewolf();
        bool isFirstPerson = world->isFirstPerson();
        if (isWerewolf && isFirstPerson)
        {
            float werewolfFov = Fallback::Map::getFloat("General_Werewolf_FOV");
            if (werewolfFov != 0)
                rendering->overrideFieldOfView(werewolfFov);
            windowMgr->setWerewolfOverlay(true);
        }
        else
        {
            rendering->resetFieldOfView();
            windowMgr->setWerewolfOverlay(false);
        }

        // Sink the camera while sneaking
        bool sneaking = playerClass.getCreatureStats(player).getStance(MWMechanics::CreatureStats::Stance_Sneak);
        bool swimming = world->isSwimming(player);
        bool flying = world->isFlying(player);

        static const float i1stPersonSneakDelta
            = store.get<ESM::GameSetting>().find("i1stPersonSneakDelta")->mValue.getFloat();
        if (sneaking && !swimming && !flying)
            rendering->getCamera()->setSneakOffset(i1stPersonSneakDelta);
        else
            rendering->getCamera()->setSneakOffset(0.f);

        int blind = 0;
        const auto& magicEffects = playerClass.getCreatureStats(player).getMagicEffects();
        if (!world->getGodModeState())
            blind = static_cast<int>(magicEffects.getOrDefault(ESM::MagicEffect::Blind).getModifier());
        windowMgr->setBlindness(std::clamp(blind, 0, 100));

        int nightEye = static_cast<int>(magicEffects.getOrDefault(ESM::MagicEffect::NightEye).getMagnitude());
        rendering->setNightEyeFactor(std::min(1.f, (nightEye / 100.f)));
    }

}
