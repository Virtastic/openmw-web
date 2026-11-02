#ifndef OPENMW_COMPONENTS_SCENEUTIL_TEXTUREATLAS_H
#define OPENMW_COMPONENTS_SCENEUTIL_TEXTUREATLAS_H

#include <vector>

#include <osg/Array>
#include <osg/Image>
#include <osg/Vec4f>
#include <osg/ref_ptr>

namespace osg
{
    class Node;
}

namespace SceneUtil
{
    /// OT3-211: load-time texture atlasing ("our Project Atlas"), written from scratch.
    ///
    /// Per mesh: the base textures of sibling shapes that differ ONLY in that texture are packed
    /// into one S3TC atlas and the shapes' UVs remapped into it. Their state sets then compare
    /// equal, so the Optimizer's SHARE_DUPLICATE_STATE + MERGE_GEOMETRY (and object paging, which
    /// merges the same templates for distant statics) collapse them into fewer draw calls. Nothing
    /// is decoded or re-encoded: DXT blocks are copied as they are (no BC7, no quality loss).

    /// A texture the packer can take: DXT1/DXT3/DXT5, power-of-two, 4..maxTile on both sides,
    /// image data present.
    bool isAtlasable(const osg::Image& image, int maxTile = 1024);

    struct AtlasResult
    {
        osg::ref_ptr<osg::Image> mImage;
        /// Per input image: (u offset, v offset, u scale, v scale) to map a [0,1] UV into the atlas.
        /// Inset by half a texel on each side so linear filtering does not pick up the neighbour.
        std::vector<osg::Vec4f> mRects;
    };

    /// Packs images that are all isAtlasable and share one pixel format into a power-of-two atlas
    /// no larger than maxSize. The atlas carries mip levels down to the one where the smallest
    /// input is a single 4x4 block (GL_TEXTURE_MAX_LEVEL is set from that by osg). Returns an
    /// empty result if they do not fit or are not compatible.
    AtlasResult buildDxtAtlas(const std::vector<const osg::Image*>& images, int maxSize = 2048);

    /// True if every coordinate is inside [0,1]: such UVs never wrap, so they survive remapping.
    bool texCoordsInUnitRange(const osg::Vec2Array& uvs);

    /// u' = rect.x + u * rect.z, v' = rect.y + v * rect.w
    void remapTexCoords(osg::Vec2Array& uvs, const osg::Vec4f& rect);

    /// Runs the atlas pass over a freshly loaded template (before the shader visitor and the
    /// optimizer). Returns how many shapes were moved onto an atlas.
    unsigned atlasTextures(osg::Node& root, int maxSize = 2048);
}

#endif
