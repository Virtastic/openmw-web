#include "textureatlas.hpp"

#include <algorithm>
#include <cstring>
#include <map>

#include <osg/Geometry>
#include <osg/Group>
#include <osg/NodeVisitor>
#include <osg/StateSet>
#include <osg/Texture2D>

#include "texturetype.hpp"

namespace SceneUtil
{
    namespace
    {
        bool isPowerOfTwo(int v)
        {
            return v > 0 && (v & (v - 1)) == 0;
        }

        int blockBytes(GLenum format)
        {
            switch (format)
            {
                case GL_COMPRESSED_RGB_S3TC_DXT1_EXT:
                case GL_COMPRESSED_RGBA_S3TC_DXT1_EXT:
                    return 8;
                case GL_COMPRESSED_RGBA_S3TC_DXT3_EXT:
                case GL_COMPRESSED_RGBA_S3TC_DXT5_EXT:
                    return 16;
                default:
                    return 0;
            }
        }

        int log2i(int v)
        {
            int r = 0;
            while (v > 1)
            {
                v >>= 1;
                ++r;
            }
            return r;
        }

        // Shelf packing of power-of-two rectangles sorted large to small. Every placed corner is a
        // multiple of the smallest width/height, which keeps every tile block-aligned in every mip
        // level the atlas carries.
        bool pack(const std::vector<std::pair<int, int>>& sizes, int atlasW, int atlasH,
            std::vector<std::pair<int, int>>& pos)
        {
            std::vector<std::size_t> order(sizes.size());
            for (std::size_t i = 0; i < order.size(); ++i)
                order[i] = i;
            std::stable_sort(order.begin(), order.end(), [&](std::size_t a, std::size_t b) {
                if (sizes[a].second != sizes[b].second)
                    return sizes[a].second > sizes[b].second;
                return sizes[a].first > sizes[b].first;
            });
            pos.assign(sizes.size(), { 0, 0 });
            int x = 0, y = 0, shelfH = 0;
            for (std::size_t i : order)
            {
                const auto [w, h] = sizes[i];
                if (w > atlasW)
                    return false;
                if (x + w > atlasW)
                {
                    y += shelfH;
                    x = 0;
                    shelfH = 0;
                }
                if (y + h > atlasH)
                    return false;
                pos[i] = { x, y };
                x += w;
                shelfH = std::max(shelfH, h);
            }
            return true;
        }
    }

    bool isAtlasable(const osg::Image& image, int maxTile)
    {
        if (blockBytes(image.getPixelFormat()) == 0 || image.data() == nullptr || image.r() != 1)
            return false;
        const int s = image.s(), t = image.t();
        return isPowerOfTwo(s) && isPowerOfTwo(t) && s >= 4 && t >= 4 && s <= maxTile && t <= maxTile;
    }

    AtlasResult buildDxtAtlas(const std::vector<const osg::Image*>& images, int maxSize)
    {
        AtlasResult result;
        if (images.size() < 2)
            return result;
        const GLenum format = images.front()->getPixelFormat();
        const int bb = blockBytes(format);
        long long area = 0;
        int minDim = maxSize;
        int levels = 64;
        std::vector<std::pair<int, int>> sizes;
        for (const osg::Image* img : images)
        {
            if (img == nullptr || !isAtlasable(*img, maxSize) || img->getPixelFormat() != format)
                return result;
            sizes.emplace_back(img->s(), img->t());
            area += static_cast<long long>(img->s()) * img->t();
            minDim = std::min({ minDim, img->s(), img->t() });
            levels = std::min(levels, static_cast<int>(img->getNumMipmapLevels()));
        }
        // Stop at the level where the smallest tile is one block: below it tiles would share blocks.
        levels = std::max(1, std::min(levels, log2i(minDim / 4) + 1));

        int w = 4, h = 4;
        while (static_cast<long long>(w) * h < area)
            (w <= h ? w : h) *= 2;
        if (w > maxSize || h > maxSize)
            return result;
        std::vector<std::pair<int, int>> pos;
        while (!pack(sizes, w, h, pos))
        {
            (w <= h ? w : h) *= 2;
            if (w > maxSize || h > maxSize)
                return result;
        }

        // Lay out the mip chain in one buffer, as osg::Image expects.
        osg::Image::MipmapDataType offsets;
        std::size_t total = 0;
        std::vector<std::size_t> levelOffset(levels);
        for (int l = 0; l < levels; ++l)
        {
            levelOffset[l] = total;
            if (l > 0)
                offsets.push_back(static_cast<unsigned int>(total));
            const int lw = std::max(4, w >> l), lh = std::max(4, h >> l);
            total += static_cast<std::size_t>(lw / 4) * (lh / 4) * bb;
        }
        unsigned char* data = new unsigned char[total];
        std::memset(data, 0, total);

        for (std::size_t i = 0; i < images.size(); ++i)
        {
            const osg::Image& img = *images[i];
            for (int l = 0; l < levels; ++l)
            {
                const int atlasRowBlocks = std::max(4, w >> l) / 4;
                const int tw = img.s() >> l, th = img.t() >> l; // >= 4 by construction of levels
                const int bx = (pos[i].first >> l) / 4, by = (pos[i].second >> l) / 4;
                const unsigned char* src = img.getMipmapData(l);
                const std::size_t srcRow = static_cast<std::size_t>(tw / 4) * bb;
                for (int row = 0; row < th / 4; ++row)
                    std::memcpy(data + levelOffset[l] + (static_cast<std::size_t>(by + row) * atlasRowBlocks + bx) * bb,
                        src + row * srcRow, srcRow);
            }
            const float iw = 1.f / w, ih = 1.f / h;
            const float tw = static_cast<float>(img.s()), th = static_cast<float>(img.t());
            result.mRects.emplace_back((pos[i].first + 0.5f) * iw, (pos[i].second + 0.5f) * ih, (tw - 1.f) * iw,
                (th - 1.f) * ih);
        }

        osg::ref_ptr<osg::Image> atlas = new osg::Image;
        atlas->setImage(w, h, 1, format, format, GL_UNSIGNED_BYTE, data, osg::Image::USE_NEW_DELETE);
        atlas->setMipmapLevels(offsets);
        atlas->setFileName("atlas");
        result.mImage = atlas;
        return result;
    }

    bool texCoordsInUnitRange(const osg::Vec2Array& uvs)
    {
        for (const osg::Vec2f& uv : uvs)
            if (!(uv.x() >= 0.f && uv.x() <= 1.f && uv.y() >= 0.f && uv.y() <= 1.f))
                return false;
        return true;
    }

    void remapTexCoords(osg::Vec2Array& uvs, const osg::Vec4f& rect)
    {
        for (osg::Vec2f& uv : uvs)
            uv.set(rect.x() + uv.x() * rect.z(), rect.y() + uv.y() * rect.w());
        uvs.dirty();
    }

    namespace
    {
        struct Candidate
        {
            osg::Group* mGroup;
            osg::Texture2D* mTexture;
            std::vector<osg::Geometry*> mGeometries;
        };

        // A shape group as nifosg builds it: its own state set carries the base texture on unit 0
        // and nothing on other units, no controllers anywhere, and only plain Geometry children
        // whose unit-0 UVs stay inside [0,1].
        class CollectVisitor : public osg::NodeVisitor
        {
        public:
            CollectVisitor()
                : osg::NodeVisitor(TRAVERSE_ALL_CHILDREN)
            {
            }

            std::vector<Candidate> mCandidates;

            void apply(osg::Group& group) override
            {
                consider(group);
                traverse(group);
            }

        private:
            void consider(osg::Group& group)
            {
                osg::StateSet* ss = group.getStateSet();
                if (ss == nullptr || group.getNumChildren() == 0 || group.getUpdateCallback() != nullptr
                    || ss->getUpdateCallback() != nullptr || ss->getEventCallback() != nullptr)
                    return;
                int overrideFx = 0;
                if (group.getUserValue("overrideFx", overrideFx))
                    return;
                const auto& units = ss->getTextureAttributeList();
                if (units.size() != 1)
                    return;
                auto* tex = dynamic_cast<osg::Texture2D*>(ss->getTextureAttribute(0, osg::StateAttribute::TEXTURE));
                if (tex == nullptr || tex->getImage() == nullptr || !isAtlasable(*tex->getImage()))
                    return;
                if (ss->getTextureAttribute(0, osg::StateAttribute::TEXMAT) != nullptr)
                    return;
                const osg::StateAttribute* type = ss->getTextureAttribute(0, TextureType::AttributeType);
                if (type == nullptr || type->getName() != "diffuseMap")
                    return;
                Candidate c{ &group, tex, {} };
                for (unsigned i = 0; i < group.getNumChildren(); ++i)
                {
                    osg::Geometry* geom = group.getChild(i)->asGeometry();
                    // Exactly osg::Geometry: rig and morph geometry rebuild their arrays.
                    if (geom == nullptr || std::strcmp(geom->className(), "Geometry") != 0
                        || geom->getUpdateCallback() != nullptr || geom->getStateSet() != nullptr)
                        return;
                    if (geom->getNumTexCoordArrays() != 1)
                        return;
                    auto* uvs = dynamic_cast<osg::Vec2Array*>(geom->getTexCoordArray(0));
                    if (uvs == nullptr || !texCoordsInUnitRange(*uvs))
                        return;
                    c.mGeometries.push_back(geom);
                }
                mCandidates.push_back(std::move(c));
            }
        };

        bool sameAttributes(const osg::StateSet::AttributeList& a, const osg::StateSet::AttributeList& b,
            bool skipTexture)
        {
            if (a.size() != b.size())
                return false;
            for (auto ia = a.begin(), ib = b.begin(); ia != a.end(); ++ia, ++ib)
            {
                if (ia->first != ib->first || ia->second.second != ib->second.second)
                    return false;
                if (skipTexture && ia->first.first == osg::StateAttribute::TEXTURE)
                    continue;
                if (ia->second.first->compare(*ib->second.first) != 0)
                    return false;
            }
            return true;
        }

        // Two state sets that differ only in the unit-0 texture, compared by value as
        // SHARE_DUPLICATE_STATE will compare them afterwards. Read-only: the attributes are shared
        // between templates, so nothing here may touch their parent lists.
        bool sameExceptTexture(const osg::StateSet& a, const osg::StateSet& b)
        {
            return a.getModeList() == b.getModeList() && a.getTextureModeList() == b.getTextureModeList()
                && a.getRenderingHint() == b.getRenderingHint() && a.getRenderBinMode() == b.getRenderBinMode()
                && a.getBinNumber() == b.getBinNumber() && a.getBinName() == b.getBinName()
                && a.getNestRenderBins() == b.getNestRenderBins() && a.getUniformList().empty()
                && b.getUniformList().empty() && a.getDefineList().empty() && b.getDefineList().empty()
                && sameAttributes(a.getAttributeList(), b.getAttributeList(), false)
                && a.getTextureAttributeList().size() == 1 && b.getTextureAttributeList().size() == 1
                && sameAttributes(a.getTextureAttributeList()[0], b.getTextureAttributeList()[0], true);
        }
    }

    unsigned atlasTextures(osg::Node& root, int maxSize)
    {
        CollectVisitor collect;
        root.accept(collect);
        if (collect.mCandidates.size() < 2)
            return 0;

        // Bucket by parent and compatible state: only siblings that will merge are worth it.
        std::vector<std::vector<Candidate*>> buckets;
        for (Candidate& c : collect.mCandidates)
        {
            bool placed = false;
            for (auto& bucket : buckets)
            {
                Candidate* first = bucket.front();
                if (first->mGroup->getParents() == c.mGroup->getParents()
                    && first->mTexture->getImage()->getPixelFormat() == c.mTexture->getImage()->getPixelFormat()
                    && sameExceptTexture(*first->mGroup->getStateSet(), *c.mGroup->getStateSet()))
                {
                    bucket.push_back(&c);
                    placed = true;
                    break;
                }
            }
            if (!placed)
                buckets.push_back({ &c });
        }

        unsigned changed = 0;
        for (auto& bucket : buckets)
        {
            std::vector<const osg::Image*> images;
            std::map<const osg::Image*, std::size_t> index;
            for (Candidate* c : bucket)
            {
                const osg::Image* img = c->mTexture->getImage();
                if (index.emplace(img, images.size()).second)
                    images.push_back(img);
            }
            if (images.size() < 2)
                continue;
            AtlasResult atlas = buildDxtAtlas(images, maxSize);
            if (!atlas.mImage)
                continue;

            osg::ref_ptr<osg::Texture2D> tex = new osg::Texture2D(atlas.mImage);
            tex->setTextureSize(atlas.mImage->s(), atlas.mImage->t());
            tex->setWrap(osg::Texture::WRAP_S, osg::Texture::CLAMP_TO_EDGE);
            tex->setWrap(osg::Texture::WRAP_T, osg::Texture::CLAMP_TO_EDGE);
            for (Candidate* c : bucket)
            {
                const osg::Vec4f& rect = atlas.mRects[index[c->mTexture->getImage()]];
                for (osg::Geometry* geom : c->mGeometries)
                {
                    // Copy: nifosg may share one array between shapes that keep their texture.
                    osg::ref_ptr<osg::Vec2Array> uvs = new osg::Vec2Array(
                        *static_cast<osg::Vec2Array*>(geom->getTexCoordArray(0)), osg::CopyOp::DEEP_COPY_ALL);
                    remapTexCoords(*uvs, rect);
                    geom->setTexCoordArray(0, uvs, osg::Array::BIND_PER_VERTEX);
                    ++changed;
                }
                c->mGroup->getStateSet()->setTextureAttribute(0, tex);
            }
        }
        return changed;
    }
}
