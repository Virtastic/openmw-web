// Modified by Virtastic (https://virtastic.app) for the OpenMW-Web port, 2025-2026.
// See WASM_ADAPTATIONS.md at the repository root for details of the changes.
#include "stateupdater.hpp"

#include <osg/Fog>
#include <osg/PolygonMode>

#include "depth.hpp"
#include "rtt.hpp"
#include "statesetupdater.hpp"

#include <components/resource/scenemanager.hpp>
#include <components/stereo/multiview.hpp>
#include <components/stereo/stereomanager.hpp>

namespace SceneUtil
{
    namespace
    {
        // osg::Uniform::set() ALWAYS bumps the uniform's modifiedCount (Uniform::dirty), which forces
        // OSG to re-issue glUniform for that uniform on every program it touches this frame — even when
        // the value is identical to last frame. These shared uniforms live at the scene ROOT (in scope
        // for every program), and most are constant frame-to-frame (near/far/screenRes/skyBlendingStart)
        // or the projection matrix while the camera projection is stable. Skipping the set() when the
        // value is unchanged keeps the modifiedCount stable, so OSG's per-location dedup skips the
        // re-upload. Pixel-identical (the same value ends up in the uniform either way).
        template <class T>
        inline void setIfChanged(osg::Uniform* u, const T& v)
        {
            if (!u)
                return;
            T cur;
            if (!u->get(cur) || cur != v)
                u->set(v);
        }
    }

    PerViewUniformStateUpdater::PerViewUniformStateUpdater(Resource::SceneManager* sceneManager, int opaqueTextureUnit)
        : mSceneManager(sceneManager)
        , mOpaqueTextureUnit(opaqueTextureUnit)
    {
    }

    void PerViewUniformStateUpdater::setDefaults(osg::StateSet* stateset)
    {
        stateset->addUniform(new osg::Uniform("projectionMatrix", osg::Matrixf{}));
        if (mSkyRTT)
            stateset->addUniform(new osg::Uniform("sky", mSkyTextureUnit));
    }

    void PerViewUniformStateUpdater::apply(osg::StateSet* stateset, osg::NodeVisitor* nv)
    {
        setIfChanged(stateset->getUniform("projectionMatrix"), mProjectionMatrix);
        if (mSkyRTT && nv->getVisitorType() == osg::NodeVisitor::CULL_VISITOR)
        {
            osg::Texture* skyTexture = mSkyRTT->getColorTexture(static_cast<osgUtil::CullVisitor*>(nv));
            stateset->setTextureAttribute(
                mSkyTextureUnit, skyTexture, osg::StateAttribute::ON | osg::StateAttribute::OVERRIDE);
        }

        if (mOpaqueTextureUnit > 0)
            stateset->setTextureAttribute(mOpaqueTextureUnit,
                mSceneManager->getOpaqueDepthTex(nv->getTraversalNumber()), osg::StateAttribute::ON);
    }

    void PerViewUniformStateUpdater::applyLeft(osg::StateSet* stateset, osgUtil::CullVisitor* nv)
    {
        stateset->getUniform("projectionMatrix")->set(getEyeProjectionMatrix(0));
    }

    void PerViewUniformStateUpdater::applyRight(osg::StateSet* stateset, osgUtil::CullVisitor* nv)
    {
        stateset->getUniform("projectionMatrix")->set(getEyeProjectionMatrix(1));
    }

    void PerViewUniformStateUpdater::setProjectionMatrix(const osg::Matrixf& projectionMatrix)
    {
        mProjectionMatrix = projectionMatrix;
    }

    const osg::Matrixf& PerViewUniformStateUpdater::getProjectionMatrix() const
    {
        return mProjectionMatrix;
    }

    void PerViewUniformStateUpdater::enableSkyRTT(int skyTextureUnit, RTTNode* skyRTT)
    {
        mSkyTextureUnit = skyTextureUnit;
        mSkyRTT = skyRTT;
    }

    osg::Matrixf PerViewUniformStateUpdater::getEyeProjectionMatrix(int view)
    {
        return Stereo::Manager::instance().computeEyeProjection(view, AutoDepth::isReversed());
    }

    SharedUniformStateUpdater::SharedUniformStateUpdater(float skyBlendingStartCoef)
        : mSkyBlendingStartCoef(skyBlendingStartCoef)
    {
    }

    void SharedUniformStateUpdater::setDefaults(osg::StateSet* stateset)
    {
        stateset->addUniform(new osg::Uniform("near", 0.f));
        stateset->addUniform(new osg::Uniform("far", 0.f));
        stateset->addUniform(new osg::Uniform("skyBlendingStart", 0.f));
        stateset->addUniform(new osg::Uniform("screenRes", osg::Vec2f{}));
        stateset->addUniform(new osg::Uniform("isReflection", false));
        stateset->addUniform(new osg::Uniform("windSpeed", 0.0f));
        stateset->addUniform(new osg::Uniform("playerPos", osg::Vec3f(0.f, 0.f, 0.f)));
        stateset->addUniform(new osg::Uniform("useTreeAnim", false));
    }

    void SharedUniformStateUpdater::apply(osg::StateSet* stateset, osg::NodeVisitor* nv)
    {
        setIfChanged(stateset->getUniform("near"), mNear);
        setIfChanged(stateset->getUniform("far"), mFar);
        setIfChanged(stateset->getUniform("skyBlendingStart"), mFar * mSkyBlendingStartCoef);
        setIfChanged(stateset->getUniform("screenRes"), mScreenRes);
        setIfChanged(stateset->getUniform("windSpeed"), mWindSpeed);
        setIfChanged(stateset->getUniform("playerPos"), mPlayerPos);
    }

    void SharedUniformStateUpdater::setNear(float near)
    {
        mNear = near;
    }

    void SharedUniformStateUpdater::setFar(float far)
    {
        mFar = far;
    }

    void SharedUniformStateUpdater::setScreenRes(float width, float height)
    {
        mScreenRes = osg::Vec2f(width, height);
    }

    void SharedUniformStateUpdater::setWindSpeed(float windSpeed)
    {
        mWindSpeed = windSpeed;
    }

    void SharedUniformStateUpdater::setPlayerPos(osg::Vec3f playerPos)
    {
        mPlayerPos = playerPos;
    }

    void StateUpdater::setDefaults(osg::StateSet* stateset)
    {
        osg::Fog* fog = new osg::Fog;
        fog->setMode(osg::Fog::LINEAR);
        stateset->setAttributeAndModes(fog, osg::StateAttribute::ON);
#ifdef __EMSCRIPTEN__
        // No fixed-function fog on GLES: the osg::Fog above is inert, so also feed gl_Fog (renamed to
        // flat osg_Fog_* uniforms by the shader transform) so the scene shaders' applyFog() actually
        // runs. Inherited down the scene graph; updated per-frame in apply().
        stateset->addUniform(new osg::Uniform("osg_Fog_color", osg::Vec4f(0.53f, 0.62f, 0.73f, 1.f)));
        stateset->addUniform(new osg::Uniform("osg_Fog_start", 0.f));
        stateset->addUniform(new osg::Uniform("osg_Fog_end", 100000.f));
        stateset->addUniform(new osg::Uniform("osg_Fog_scale", 0.f));
        stateset->addUniform(new osg::Uniform("osg_Fog_density", 0.f));
#endif
        if (mWireframe)
        {
            osg::PolygonMode* polygonmode = new osg::PolygonMode;
            polygonmode->setMode(osg::PolygonMode::FRONT_AND_BACK, osg::PolygonMode::LINE);
            stateset->setAttributeAndModes(polygonmode, osg::StateAttribute::ON);
        }
        else
            stateset->removeAttribute(osg::StateAttribute::POLYGONMODE);
    }

    void StateUpdater::apply(osg::StateSet* stateset, osg::NodeVisitor*)
    {
        configureSunAmbientOverride(mAmbientColor, stateset);
        osg::Fog* fog = static_cast<osg::Fog*>(stateset->getAttribute(osg::StateAttribute::FOG));
        fog->setColor(mFogColor);
        fog->setStart(mFogStart);
        fog->setEnd(mFogEnd);
#ifdef __EMSCRIPTEN__
        // Mirror the fog state into the flat uniforms the GLES shaders read. scale = 1/(end-start)
        // is what fixed-function GL derives internally for LINEAR fog; guard the degenerate range.
        const float range = mFogEnd - mFogStart;
        stateset->getUniform("osg_Fog_color")->set(mFogColor);
        stateset->getUniform("osg_Fog_start")->set(mFogStart);
        stateset->getUniform("osg_Fog_end")->set(mFogEnd);
        stateset->getUniform("osg_Fog_scale")->set(range > 1e-4f ? 1.f / range : 0.f);
#endif
    }

    void StateUpdater::setAmbientColor(const osg::Vec4f& col)
    {
        mAmbientColor = col;
    }

    void StateUpdater::setFogColor(const osg::Vec4f& col)
    {
        mFogColor = col;
    }

    void StateUpdater::setFogStart(float start)
    {
        mFogStart = start;
    }

    void StateUpdater::setFogEnd(float end)
    {
        mFogEnd = end;
    }

    void StateUpdater::setWireframe(bool wireframe)
    {
        if (mWireframe != wireframe)
        {
            mWireframe = wireframe;
            reset();
        }
    }

    bool StateUpdater::getWireframe() const
    {
        return mWireframe;
    }

}
