// Added by Virtastic (https://virtastic.app) for the OpenMW-Web port, 2025-2026.
// See WASM_ADAPTATIONS.md at the repository root for details of the changes.
#ifndef GAME_MWGUI_NULLWINDOWMANAGER_H
#define GAME_MWGUI_NULLWINDOWMANAGER_H

// E2 (MP): the headless sim peer's WindowManager — every method a no-op.
//
// MWBase::WindowManager is already a pure abstract interface, so the ~318 call sites outside
// mwgui need no change at all; this file plus a two-line selection in engine.cpp is what
// deletes MyGUI init, font/skin/layout loading and initUI() from the peer's boot. The real
// MWGui::WindowManager is untouched and single-player always takes it.
//
// The non-trivial answers, each deliberate:
// - getLoadingScreen() returns a live no-op Loading::Listener, never null — data loading
//   drives it unconditionally.
// - isGuiMode()/containsMode() are false: engine.cpp gates global scripts on them.
// - isWindowVisible() is true, or the frame loop would pause the peer forever.
// - isSavingAllowed() is false: nothing about a peer's state is a savegame.
// - executeInConsole() only logs — the console runner lives in MWGui::Console. The one MP
//   caller (mp.runConsole) therefore cannot target the peer; ops tooling consoles clients.
// - readPressedButton() is -1 ("no button"), matching the documented no-press answer.

#include <components/debug/debuglog.hpp>
#include <components/esm/refid.hpp>
#include <components/loadinglistener/loadinglistener.hpp>
#include <components/translation/translation.hpp>

#include "../mwbase/windowmanager.hpp"

#include "../mwworld/ptr.hpp"

#include "textcolours.hpp"

namespace MWGui
{
    class NullWindowManager : public MWBase::WindowManager
    {
    public:
        NullWindowManager() = default;

        void playVideo(std::string_view, bool, bool) override {}
        void setNewGame(bool) override {}
        void pushGuiMode(MWGui::GuiMode, const MWWorld::Ptr&) override {}
        void pushGuiMode(MWGui::GuiMode) override {}
        void popGuiMode(bool) override {}
        void removeGuiMode(MWGui::GuiMode) override {}
        void goToJail(int) override {}
        void updatePlayer() override {}
        MWGui::GuiMode getMode() const override { return MWGui::GM_None; }
        bool containsMode(MWGui::GuiMode) const override { return false; }
        bool isGuiMode() const override { return false; }
        bool isConsoleMode() const override { return false; }
        bool isPostProcessorHudVisible() const override { return false; }
        bool isSettingsWindowVisible() const override { return false; }
        bool isInteractiveMessageBoxActive() const override { return false; }
        void toggleVisible(MWGui::GuiWindow) override {}
        void forceHide(MWGui::GuiWindow) override {}
        void unsetForceHide(MWGui::GuiWindow) override {}
        void disallowAll() override {}
        void allow(MWGui::GuiWindow) override {}
        bool isAllowed(MWGui::GuiWindow) const override { return false; }
        MWGui::InventoryWindow* getInventoryWindow() override { return nullptr; }
        MWGui::CountDialog* getCountDialog() override { return nullptr; }
        MWGui::ConfirmationDialog* getConfirmationDialog() override { return nullptr; }
        MWGui::TradeWindow* getTradeWindow() override { return nullptr; }
        MWGui::HUD* getHud() override { return nullptr; }
        MWGui::PostProcessorHud* getPostProcessorHud() override { return nullptr; }
        std::vector<MWGui::WindowBase*> getGuiModeWindows(MWGui::GuiMode) override { return {}; }
        void useItem(const MWWorld::Ptr&, bool) override {}
        void updateSpellWindow() override {}
        void setConsoleSelectedObject(const MWWorld::Ptr&) override {}
        MWWorld::Ptr getConsoleSelectedObject() const override { return {}; }
        void setConsoleMode(std::string_view) override {}
        const std::string& getConsoleMode() override { return mEmptyString; }
        void printToConsole(const std::string&, std::string_view) override {}
        void setDrowningTimeLeft(float, float) override {}
        void changeCell(const MWWorld::CellStore*) override {}
        void setFocusObject(const MWWorld::Ptr&) override {}
        void setFocusObjectScreenCoords(float, float) override {}
        void setCursorVisible(bool) override {}
        void setCursorActive(bool) override {}
        void getMousePosition(int& x, int& y) override { x = 0; y = 0; }
        void getMousePosition(float& x, float& y) override
        {
            x = 0.f;
            y = 0.f;
        }
        void setDragDrop(bool) override {}
        bool getWorldMouseOver() override { return false; }
        float getScalingFactor() const override { return 1.f; }
        bool toggleFogOfWar() override { return false; }
        bool toggleFullHelp() override { return false; }
        bool getFullHelp() const override { return false; }
        void setDrowningBarVisibility(bool) override {}
        void setHMSVisibility(bool) override {}
        void setMinimapVisibility(bool) override {}
        void setWeaponVisibility(bool) override {}
        void setSpellVisibility(bool) override {}
        void setSneakVisibility(bool) override {}
        void activateQuickKey(int) override {}
        void updateActivatedQuickKey() override {}
        const ESM::RefId& getSelectedSpell() override { return mEmptyRefId; }
        void setSelectedSpell(const ESM::RefId&, int) override {}
        void setSelectedEnchantItem(const MWWorld::Ptr&) override {}
        const MWWorld::Ptr& getSelectedEnchantItem() const override { return mEmptyPtr; }
        void setSelectedWeapon(const MWWorld::Ptr&) override {}
        const MWWorld::Ptr& getSelectedWeapon() const override { return mEmptyPtr; }
        void unsetSelectedSpell() override {}
        void unsetSelectedWeapon() override {}
        void showCrosshair(bool) override {}
        bool setHudVisibility(bool) override { return false; }
        bool isHudVisible() const override { return false; }
        void disallowMouse() override {}
        void allowMouse() override {}
        void notifyInputActionBound() override {}
        void addVisitedLocation(const std::string&, int, int) override {}
        void removeDialog(std::unique_ptr<MWGui::Layout>&&) override {}
        void exitCurrentGuiMode() override {}
        void messageBox(std::string_view message, enum MWGui::ShowInDialogueMode) override
        {
            Log(Debug::Verbose) << "[headless] messageBox: " << message;
        }
        void scheduleMessageBox(std::string message, enum MWGui::ShowInDialogueMode) override
        {
            Log(Debug::Verbose) << "[headless] messageBox: " << message;
        }
        void staticMessageBox(std::string_view) override {}
        void removeStaticMessageBox() override {}
        void interactiveMessageBox(std::string_view message, const std::vector<std::string>&, bool, int) override
        {
            Log(Debug::Verbose) << "[headless] interactiveMessageBox: " << message;
        }
        int readPressedButton() override { return -1; }
        void updateConsoleObjectPtr(const MWWorld::Ptr&, const MWWorld::Ptr&) override {}
        std::string_view getGameSettingString(std::string_view, std::string_view defaultValue) override
        {
            // Honest enough for a peer: GMST strings are UI copy, and returning the caller's
            // own default keeps every consumer total.
            return defaultValue;
        }
        void processChangedSettings(const std::set<std::pair<std::string, std::string>>&) override {}
        void executeInConsole(const std::filesystem::path& path) override
        {
            Log(Debug::Warning) << "[headless] executeInConsole ignored (no console): " << path;
        }
        void enableRest() override {}
        bool getRestEnabled() override { return true; }
        bool getJournalAllowed() override { return true; }
        bool getPlayerSleeping() override { return false; }
        void wakeUpPlayer() override {}
        void showSoulgemDialog(MWWorld::Ptr) override {}
        void changePointer(const std::string&) override {}
        void setEnemy(const MWWorld::Ptr&) override {}
        std::size_t getMessagesCount() const override { return 0; }
        const Translation::Storage& getTranslationDataStorage() const override { return mTranslationStorage; }
        void setKeyFocusWidget(MyGUI::Widget*) override {}
        Loading::Listener* getLoadingScreen() override { return &mNullListener; }
        bool getCursorVisible() override { return false; }
        void clear() override {}
        void write(ESM::ESMWriter&, Loading::Listener&) override {}
        void readRecord(ESM::ESMReader&, uint32_t) override {}
        size_t countSavedGameRecords() const override { return 0; }
        bool isSavingAllowed() const override { return false; }
        void exitCurrentModal() override {}
        void addCurrentModal(MWGui::WindowModal*) override {}
        void removeCurrentModal(MWGui::WindowModal*) override {}
        void pinWindow(MWGui::GuiWindow) override {}
        void toggleMaximized(MWGui::Layout*) override {}
        void fadeScreenIn(const float, bool, float) override {}
        void fadeScreenOut(const float, bool, float) override {}
        void fadeScreenTo(const int, const float, bool, float) override {}
        void setBlindness(const int) override {}
        void activateHitOverlay(bool) override {}
        void setWerewolfOverlay(bool) override {}
        void toggleConsole() override {}
        void toggleDebugWindow() override {}
        void togglePostProcessorHud() override {}
        void toggleSettingsWindow() override {}
        void cycleSpell(bool) override {}
        void cycleWeapon(bool) override {}
        void playSound(const ESM::RefId&, float, float) override {}
        void addCell(MWWorld::CellStore*) override {}
        void removeCell(MWWorld::CellStore*) override {}
        void writeFog(MWWorld::CellStore*) override {}
        const MWGui::TextColours& getTextColours() override { return mTextColours; }
        bool injectKeyPress(MyGUI::KeyCode, unsigned int, bool) override { return false; }
        bool injectKeyRelease(MyGUI::KeyCode) override { return false; }
        void windowVisibilityChange(bool) override {}
        void windowResized(int, int) override {}
        void windowClosed() override {}
        // TRUE, or the frame loop pauses the peer forever (engine.cpp pauses playback and
        // skips the frame when the window is "hidden" — a peer has no window to show).
        bool isWindowVisible() const override { return true; }
        void watchActor(const MWWorld::Ptr&) override {}
        MWWorld::Ptr getWatchedActor() const override { return {}; }
        const std::string& getVersionDescription() const override { return mEmptyString; }
        void onDeleteCustomData(const MWWorld::Ptr&) override {}
        void forceLootMode(const MWWorld::Ptr&) override {}
        void asyncPrepareSaveMap() override {}
        void setCullMask(uint32_t) override {}
        uint32_t getCullMask() override { return 0; }
        void inventoryUpdated(const MWWorld::Ptr&) const override {}
        MWGui::WindowBase* getActiveControllerWindow() override { return nullptr; }
        int getControllerMenuHeight() override { return 0; }
        void cycleActiveControllerWindow(bool) override {}
        void setActiveControllerWindow(MWGui::GuiMode, size_t) override {}
        bool getControllerTooltipVisible() const override { return false; }
        void setControllerTooltipVisible(bool) override {}
        bool getControllerTooltipEnabled() const override { return false; }
        void setControllerTooltipEnabled(bool) override {}
        void restoreControllerTooltips() override {}
        void updateControllerButtonsOverlay() override {}
        const std::vector<MWGui::GuiMode>& getGuiModeStack() const override { return mEmptyModeStack; }
        void setDisabledByLua(std::string_view, bool) override {}
        bool isWindowVisible(std::string_view) const override { return false; }
        std::vector<std::string_view> getAllWindowIds() const override { return {}; }
        std::vector<std::string_view> getAllowedWindowIds(MWGui::GuiMode) const override { return {}; }

    private:
        Loading::Listener mNullListener;
        Translation::Storage mTranslationStorage;
        MWGui::TextColours mTextColours{};
        MWWorld::Ptr mEmptyPtr;
        std::string mEmptyString;
        ESM::RefId mEmptyRefId;
        std::vector<MWGui::GuiMode> mEmptyModeStack;
    };
}

#endif
