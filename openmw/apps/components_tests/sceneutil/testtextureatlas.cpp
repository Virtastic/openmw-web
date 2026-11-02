#include <components/sceneutil/textureatlas.hpp>
#include <components/sceneutil/texturetype.hpp>

#include <osg/Geometry>
#include <osg/Group>
#include <osg/Material>
#include <osg/Texture2D>

#include <gtest/gtest.h>

#include <cstring>

namespace
{
    using namespace SceneUtil;

    // A DXT image of w x h whose every block at mip level l is filled with byte `fill + l`, so the
    // atlas contents can be checked block by block.
    osg::ref_ptr<osg::Image> makeDxt(int w, int h, unsigned char fill, GLenum format = GL_COMPRESSED_RGB_S3TC_DXT1_EXT)
    {
        const int bb = format == GL_COMPRESSED_RGBA_S3TC_DXT5_EXT ? 16 : 8;
        osg::Image::MipmapDataType offsets;
        std::size_t total = 0;
        int levels = 0;
        for (int lw = w, lh = h; lw >= 1 && lh >= 1; lw /= 2, lh /= 2, ++levels)
        {
            if (levels > 0)
                offsets.push_back(static_cast<unsigned>(total));
            total += static_cast<std::size_t>(std::max(1, lw / 4)) * std::max(1, lh / 4) * bb;
        }
        unsigned char* data = new unsigned char[total];
        std::size_t at = 0;
        int l = 0;
        for (int lw = w, lh = h; lw >= 1 && lh >= 1; lw /= 2, lh /= 2, ++l)
        {
            const std::size_t n = static_cast<std::size_t>(std::max(1, lw / 4)) * std::max(1, lh / 4) * bb;
            std::memset(data + at, fill + l, n);
            at += n;
        }
        osg::ref_ptr<osg::Image> img = new osg::Image;
        img->setImage(w, h, 1, format, format, GL_UNSIGNED_BYTE, data, osg::Image::USE_NEW_DELETE);
        img->setMipmapLevels(offsets);
        return img;
    }

    unsigned char blockAt(const osg::Image& atlas, int level, int px, int py, int bb)
    {
        const int rowBlocks = std::max(4, atlas.s() >> level) / 4;
        return atlas.getMipmapData(level)[(static_cast<std::size_t>(py / 4) * rowBlocks + px / 4) * bb];
    }

    TEST(SceneUtilTextureAtlas, acceptsOnlyPowerOfTwoS3tc)
    {
        EXPECT_TRUE(isAtlasable(*makeDxt(64, 32, 1)));
        EXPECT_FALSE(isAtlasable(*makeDxt(64, 32, 1), 32));
        osg::ref_ptr<osg::Image> rgba = new osg::Image;
        rgba->allocateImage(64, 64, 1, GL_RGBA, GL_UNSIGNED_BYTE);
        EXPECT_FALSE(isAtlasable(*rgba));
        osg::ref_ptr<osg::Image> npot = makeDxt(64, 64, 1);
        npot->setImage(48, 64, 1, GL_COMPRESSED_RGB_S3TC_DXT1_EXT, GL_COMPRESSED_RGB_S3TC_DXT1_EXT, GL_UNSIGNED_BYTE,
            new unsigned char[12 * 16 * 8], osg::Image::USE_NEW_DELETE);
        EXPECT_FALSE(isAtlasable(*npot));
    }

    TEST(SceneUtilTextureAtlas, copiesBlocksIntoPlaceOnEveryLevel)
    {
        auto a = makeDxt(64, 64, 10);
        auto b = makeDxt(32, 32, 50);
        auto c = makeDxt(32, 32, 90);
        AtlasResult r = buildDxtAtlas({ a.get(), b.get(), c.get() });
        ASSERT_TRUE(r.mImage);
        ASSERT_EQ(r.mRects.size(), 3u);
        EXPECT_EQ(r.mImage->getPixelFormat(), static_cast<GLenum>(GL_COMPRESSED_RGB_S3TC_DXT1_EXT));
        // 64x64 + two 32x32 fit in 128x64.
        EXPECT_EQ(r.mImage->s(), 128);
        EXPECT_EQ(r.mImage->t(), 64);
        // Mips stop where the smallest tile (32) is one block: 32,16,8,4 -> 4 levels.
        EXPECT_EQ(r.mImage->getNumMipmapLevels(), 4u);

        const osg::Image* imgs[] = { a.get(), b.get(), c.get() };
        const unsigned char fills[] = { 10, 50, 90 };
        for (int i = 0; i < 3; ++i)
        {
            const osg::Vec4f& rect = r.mRects[i];
            // Recover the pixel origin from the half-texel inset.
            const int px = static_cast<int>(rect.x() * 128.f - 0.5f + 0.01f);
            const int py = static_cast<int>(rect.y() * 64.f - 0.5f + 0.01f);
            EXPECT_EQ(px % 4, 0);
            EXPECT_EQ(py % 4, 0);
            EXPECT_NEAR(rect.z(), (imgs[i]->s() - 1.f) / 128.f, 1e-6);
            EXPECT_NEAR(rect.w(), (imgs[i]->t() - 1.f) / 64.f, 1e-6);
            for (int l = 0; l < 4; ++l)
            {
                EXPECT_EQ(blockAt(*r.mImage, l, px >> l, py >> l, 8), fills[i] + l) << "tile " << i << " level " << l;
                EXPECT_EQ(blockAt(*r.mImage, l, ((px + imgs[i]->s()) >> l) - 4, ((py + imgs[i]->t()) >> l) - 4, 8),
                    fills[i] + l)
                    << "tile " << i << " level " << l << " far corner";
            }
        }
    }

    TEST(SceneUtilTextureAtlas, refusesMixedFormatsSingleImagesAndOversize)
    {
        auto a = makeDxt(64, 64, 1);
        auto d5 = makeDxt(64, 64, 1, GL_COMPRESSED_RGBA_S3TC_DXT5_EXT);
        EXPECT_FALSE(buildDxtAtlas({ a.get(), d5.get() }).mImage);
        EXPECT_FALSE(buildDxtAtlas({ a.get() }).mImage);
        auto big1 = makeDxt(1024, 1024, 1);
        auto big2 = makeDxt(1024, 1024, 2);
        EXPECT_FALSE(buildDxtAtlas({ big1.get(), big2.get() }, 1024).mImage);
        EXPECT_TRUE(buildDxtAtlas({ big1.get(), big2.get() }, 2048).mImage);
    }

    TEST(SceneUtilTextureAtlas, remapsOnlyUnitRangeCoordinates)
    {
        osg::ref_ptr<osg::Vec2Array> uv = new osg::Vec2Array;
        uv->push_back({ 0, 0 });
        uv->push_back({ 1, 1 });
        uv->push_back({ 0.5f, 0.25f });
        EXPECT_TRUE(texCoordsInUnitRange(*uv));
        remapTexCoords(*uv, osg::Vec4f(0.5f, 0.25f, 0.5f, 0.25f));
        EXPECT_EQ((*uv)[0], osg::Vec2f(0.5f, 0.25f));
        EXPECT_EQ((*uv)[1], osg::Vec2f(1.f, 0.5f));
        EXPECT_EQ((*uv)[2], osg::Vec2f(0.75f, 0.3125f));
        uv->push_back({ 1.5f, 0 });
        EXPECT_FALSE(texCoordsInUnitRange(*uv));
    }

    // The shape layout nifosg produces: a group per shape carrying the texture, with the geometry
    // under it.
    osg::ref_ptr<osg::Group> shape(osg::Image* img, osg::Material* mat, std::vector<osg::Vec2f> uvs)
    {
        osg::ref_ptr<osg::Group> g = new osg::Group;
        osg::StateSet* ss = g->getOrCreateStateSet();
        ss->setTextureAttributeAndModes(0, new osg::Texture2D(img), osg::StateAttribute::ON);
        ss->setTextureAttributeAndModes(0, new SceneUtil::TextureType("diffuseMap"), osg::StateAttribute::ON);
        ss->setAttributeAndModes(mat, osg::StateAttribute::ON);
        osg::ref_ptr<osg::Geometry> geom = new osg::Geometry;
        osg::ref_ptr<osg::Vec3Array> verts = new osg::Vec3Array(static_cast<unsigned>(uvs.size()));
        geom->setVertexArray(verts);
        geom->setTexCoordArray(0, new osg::Vec2Array(uvs.begin(), uvs.end()), osg::Array::BIND_PER_VERTEX);
        g->addChild(geom);
        return g;
    }

    TEST(SceneUtilTextureAtlas, sharesOneAtlasBetweenSiblingsThatDifferOnlyInTexture)
    {
        auto a = makeDxt(64, 64, 1);
        auto b = makeDxt(64, 64, 2);
        osg::ref_ptr<osg::Material> mat = new osg::Material;
        osg::ref_ptr<osg::Material> sameMat = new osg::Material; // equal by value
        osg::ref_ptr<osg::Group> root = new osg::Group;
        auto s1 = shape(a.get(), mat.get(), { { 0, 0 }, { 1, 1 } });
        auto s2 = shape(b.get(), sameMat.get(), { { 0, 0 }, { 1, 1 } });
        auto tiled = shape(b.get(), mat.get(), { { 0, 0 }, { 4, 4 } }); // wraps: must keep its texture
        root->addChild(s1);
        root->addChild(s2);
        root->addChild(tiled);
        const osg::Array* tiledUv = tiled->getChild(0)->asGeometry()->getTexCoordArray(0);

        EXPECT_EQ(atlasTextures(*root), 2u);
        auto tex = [](osg::Group* g) { return g->getStateSet()->getTextureAttribute(0, osg::StateAttribute::TEXTURE); };
        EXPECT_EQ(tex(s1), tex(s2));
        EXPECT_EQ(static_cast<const osg::Texture2D*>(tex(s1))->getImage()->s(), 128);
        EXPECT_NE(tex(tiled), tex(s1));
        EXPECT_EQ(tiled->getChild(0)->asGeometry()->getTexCoordArray(0), tiledUv);
        const auto& uv1 = *static_cast<const osg::Vec2Array*>(s1->getChild(0)->asGeometry()->getTexCoordArray(0));
        const auto& uv2 = *static_cast<const osg::Vec2Array*>(s2->getChild(0)->asGeometry()->getTexCoordArray(0));
        EXPECT_NE(uv1[0], uv2[0]);
        EXPECT_LT(uv1[1].x(), 1.f);
    }

    TEST(SceneUtilTextureAtlas, leavesShapesWithDifferentStateAlone)
    {
        auto a = makeDxt(64, 64, 1);
        auto b = makeDxt(64, 64, 2);
        osg::ref_ptr<osg::Material> red = new osg::Material;
        red->setDiffuse(osg::Material::FRONT_AND_BACK, osg::Vec4f(1, 0, 0, 1));
        osg::ref_ptr<osg::Material> blue = new osg::Material;
        blue->setDiffuse(osg::Material::FRONT_AND_BACK, osg::Vec4f(0, 0, 1, 1));
        osg::ref_ptr<osg::Group> root = new osg::Group;
        root->addChild(shape(a.get(), red.get(), { { 0, 0 } }));
        root->addChild(shape(b.get(), blue.get(), { { 0, 0 } }));
        EXPECT_EQ(atlasTextures(*root), 0u);
    }
}
