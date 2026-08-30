// Modified by Virtastic (https://virtastic.app) for the OpenMW-Web port, 2025-2026.
// See WASM_ADAPTATIONS.md at the repository root for details of the changes.
#include "imagemanager.hpp"

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif

#include <cstdlib>

#include <cassert>
#include <osgDB/Registry>

#include <components/debug/debuglog.hpp>
#include <components/misc/pathhelpers.hpp>
#include <components/sceneutil/glextensions.hpp>
#include <components/vfs/manager.hpp>
#include <components/vfs/pathutil.hpp>

#include "objectcache.hpp"

#ifdef OSG_LIBRARY_STATIC
// This list of plugins should match with the list in the top-level CMakelists.txt.
USE_OSGPLUGIN(png)
USE_OSGPLUGIN(tga)
USE_OSGPLUGIN(dds)
USE_OSGPLUGIN(jpeg)
USE_OSGPLUGIN(bmp)
USE_OSGPLUGIN(osg)
USE_SERIALIZER_WRAPPER_LIBRARY(osg)
#endif

namespace
{

    osg::ref_ptr<osg::Image> createWarningImage()
    {
        osg::ref_ptr<osg::Image> warningImage = new osg::Image;

        int width = 8, height = 8;
        warningImage->allocateImage(width, height, 1, GL_RGB, GL_UNSIGNED_BYTE);
        assert(warningImage->isDataContiguous());
        unsigned char* data = warningImage->data();
        for (int i = 0; i < width * height; ++i)
        {
            data[3 * i] = (255);
            data[3 * i + 1] = (0);
            data[3 * i + 2] = (255);
        }
        return warningImage;
    }

    bool isS3TC(osg::Image* image)
    {
        switch (image->getPixelFormat())
        {
            case GL_COMPRESSED_RGB_S3TC_DXT1_EXT:
            case GL_COMPRESSED_RGBA_S3TC_DXT1_EXT:
            case GL_COMPRESSED_RGBA_S3TC_DXT3_EXT:
            case GL_COMPRESSED_RGBA_S3TC_DXT5_EXT:
                return true;
        }
        return false;
    }

    bool checkSupported(osg::Image* image)
    {
        // not bothering with checks for other compression formats right now
        if (!isS3TC(image))
            return true;

        // hashtag yolo (CS might not have context when loading assets)
        if (!SceneUtil::glExtensionsReady())
            return true;

        return SceneUtil::getGLExtensions().isTextureCompressionS3TCSupported;
    }

}

namespace Resource
{

    ImageManager::ImageManager(const VFS::Manager* vfs, double expiryDelay)
        : ResourceManager(vfs, expiryDelay)
        , mWarningImage(createWarningImage())
        , mOptions(new osgDB::Options("dds_dxt1_detect_rgba ignoreTga2Fields"))
    {
    }

    ImageManager::~ImageManager() {}

    osg::ref_ptr<osg::Image> ImageManager::getImage(VFS::Path::NormalizedView path, bool disableFlip)
    {
        // HEADLESS: the sim peer renders nothing anyone will ever see, so decoding textures
        // buys it nothing and costs it everything — nifloader decodes at LOAD time, and the
        // engine sets setUnRefImageDataAfterApply(false), so every byte decoded here stays
        // resident for the life of the process (unref fires on GL apply, which never happens).
        // Hand back the shared 8x8 warning image instead. Nothing in mwmechanics, mwphysics or
        // detournavigator reads pixels: collision uses mesh geometry and the navmesh is built
        // from Bullet shapes, neither of which comes through here.
        static const bool sHeadless = std::getenv("OPENMW_HEADLESS") != nullptr;
        if (sHeadless)
            return mWarningImage;

        osg::ref_ptr<osg::Object> obj = mCache->getRefFromObjectCache(path);
        if (obj)
            return osg::ref_ptr<osg::Image>(static_cast<osg::Image*>(obj.get()));
        else
        {
            Files::IStreamPtr stream;
            try
            {
                stream = mVFS->get(path);
            }
            catch (std::exception& e)
            {
                Log(Debug::Error) << "Failed to open image: " << e.what();
                mCache->addEntryToObjectCache(path.value(), mWarningImage);
                return mWarningImage;
            }

            const std::string ext(Misc::getFileExtension(path.value()));
            osgDB::ReaderWriter* reader = osgDB::Registry::instance()->getReaderWriterForExtension(ext);
            if (!reader)
            {
                Log(Debug::Error) << "Error loading " << path << ": no readerwriter for '" << ext << "' found";
                mCache->addEntryToObjectCache(path.value(), mWarningImage);
                return mWarningImage;
            }

            bool killAlpha = false;
            if (reader->supportedExtensions().count("tga"))
            {
                // Morrowind ignores the alpha channel of 16bpp TGA files even when the header says not to
                unsigned char header[18];
                stream->read((char*)header, 18);
                if (stream->gcount() != 18)
                {
                    Log(Debug::Error) << "Error loading " << path << ": couldn't read TGA header";
                    mCache->addEntryToObjectCache(path.value(), mWarningImage);
                    return mWarningImage;
                }
                int type = header[2];
                int depth;
                if (type == 1 || type == 9)
                    depth = header[7];
                else
                    depth = header[16];
                int alphaBPP = header[17] & 0x0F;
                killAlpha = depth == 16 && alphaBPP == 1;
                stream->seekg(0);
            }

            osgDB::ReaderWriter::ReadResult result = reader->readImage(*stream, mOptions);
            if (!result.success())
            {
                Log(Debug::Error) << "Error loading " << path << ": " << result.message() << " code "
                                  << result.status();
                mCache->addEntryToObjectCache(path.value(), mWarningImage);
                return mWarningImage;
            }

            osg::ref_ptr<osg::Image> image = result.getImage();

            image->setFileName(std::string(path.value()));
            if (!checkSupported(image))
            {
                static bool uncompress = (getenv("OPENMW_DECOMPRESS_TEXTURES") != nullptr);
                if (!uncompress)
                {
                    Log(Debug::Error) << "Error loading " << path << ": no S3TC texture compression support installed";
                    mCache->addEntryToObjectCache(path.value(), mWarningImage);
                    return mWarningImage;
                }
                else
                {
                    // decompress texture in software if not supported by GPU
                    // requires update to getColor() to be released with OSG 3.6
                    osg::ref_ptr<osg::Image> newImage = new osg::Image;
                    newImage->setFileName(image->getFileName());
                    newImage->setOrigin(image->getOrigin());
                    newImage->allocateImage(image->s(), image->t(), image->r(),
                        image->isImageTranslucent() ? GL_RGBA : GL_RGB, GL_UNSIGNED_BYTE);
                    for (int s = 0; s < image->s(); ++s)
                        for (int t = 0; t < image->t(); ++t)
                            for (int r = 0; r < image->r(); ++r)
                                newImage->setColor(image->getColor(s, t, r), s, t, r);
                    image = newImage;
                }
            }
            else if (killAlpha)
            {
                osg::ref_ptr<osg::Image> newImage = new osg::Image;
                newImage->setFileName(image->getFileName());
                newImage->setOrigin(image->getOrigin());
                newImage->allocateImage(image->s(), image->t(), image->r(), GL_RGB, GL_UNSIGNED_BYTE);
                // OSG just won't write the alpha as there's nowhere to put it.
                for (int s = 0; s < image->s(); ++s)
                    for (int t = 0; t < image->t(); ++t)
                        for (int r = 0; r < image->r(); ++r)
                            newImage->setColor(image->getColor(s, t, r), s, t, r);
                image = newImage;
            }

#ifdef __EMSCRIPTEN__
            // WebGL2/GLES3 does not accept GL_BGRA / GL_BGR as a glTexImage2D source
            // 'format' (they are desktop-GL only). OSG's DDS reader loads Morrowind's
            // uncompressed A8R8G8B8 / R8G8B8 GUI textures with pixelFormat GL_BGRA/GL_BGR,
            // so the upload fails with GL_INVALID_ENUM and the texture samples as black
            // (this is why menus/HUD render as black boxes). Rewrite to RGBA/RGB here.
            {
                const GLenum pf = image->getPixelFormat();
                if (pf == GL_BGRA || pf == GL_BGR)
                {
                    if (image->getDataType() == GL_UNSIGNED_BYTE)
                    {
                        // 8-bit data: must physically swap R<->B channels.
                        const int comps = (pf == GL_BGRA) ? 4 : 3;
                        const GLenum newFmt = (pf == GL_BGRA) ? GL_RGBA : GL_RGB;
                        osg::ref_ptr<osg::Image> rgba = new osg::Image;
                        rgba->setFileName(image->getFileName());
                        rgba->setOrigin(image->getOrigin());
                        rgba->allocateImage(image->s(), image->t(), image->r(), newFmt, GL_UNSIGNED_BYTE);
                        const unsigned char* src = image->data();
                        unsigned char* dst = rgba->data();
                        const size_t px = size_t(image->s()) * image->t() * image->r();
                        for (size_t i = 0; i < px; ++i)
                        {
                            dst[i * comps + 0] = src[i * comps + 2]; // R <- B
                            dst[i * comps + 1] = src[i * comps + 1]; // G
                            dst[i * comps + 2] = src[i * comps + 0]; // B <- R
                            if (comps == 4)
                                dst[i * comps + 3] = src[i * comps + 3]; // A
                        }
                        image = rgba;
                    }
                    else
                    {
                        // Packed *_REV types already carry correct channel order for RGBA;
                        // just relabel so WebGL accepts the enum.
                        image->setPixelFormat((pf == GL_BGRA) ? GL_RGBA : GL_RGB);
                    }
                }
            }
#endif

            // OSG might not set the right origin for DDS
            if (ext == "dds")
                image->setOrigin(osg::Image::TOP_LEFT);

            // Convert the image to the convention we expect
            if (image->getOrigin() == osg::Image::BOTTOM_LEFT && !disableFlip)
            {
                if (image->isCompressed() && !isS3TC(image))
                {
                    // This is most likely a KTX texture that OSG can't flip
                    // We don't want it to be corrupted or displayed incorrectly, so bail
                    // OSGoS *can* flip RGTC, but we can't verify that (yet?)
                    Log(Debug::Error) << "Error loading " << path << ": cannot flip non-S3TC compressed texture";
                    mCache->addEntryToObjectCache(path.value(), mWarningImage);
                    return mWarningImage;
                }

                image->flipVertical();
                image->setOrigin(osg::Image::TOP_LEFT);
            }

#ifdef __EMSCRIPTEN__
            // F17 measurement. WebGL2 rejects glGenerateMipmap on block-compressed data, so the OSG
            // patch drops MIN_FILTER to LINEAR for any compressed texture that arrives without
            // stored mips -- costing not just aliasing but GPU texture-cache thrash at range, and
            // this build renders to 16384 units.
            //
            // The plan's own instruction for F17 is "instrument how many textures actually hit that
            // branch" before building an offline mip pipeline: if retail DDS mostly carries mips and
            // only the optional asset pack offends, the fix is a one-time repack, not a pipeline.
            // Counted here rather than in the OSG patch because this needs no deps rebuild.
            // Read it from JS as window.__omwTexStats.
            {
                static int sTotal = 0, sCompressed = 0, sCompressedNoMips = 0;
                ++sTotal;
                if (image->isCompressed())
                {
                    ++sCompressed;
                    if (!image->isMipmap())
                        ++sCompressedNoMips;
                }
                // Republish on a cadence rather than every image: this runs for every texture the
                // game loads, and the point is the ratio, not the exact instant.
                if ((sTotal & 0x3F) == 0)
                {
                    // Field-by-field, not an object literal: EM_ASM is a variadic macro, so the
                    // commas inside `{ a: $0, b: $1 }` would split it into extra macro arguments.
                    // clang-format off
                    EM_ASM({
                        var s = globalThis.__omwTexStats || {};
                        s.total = $0;
                        s.compressed = $1;
                        s.compressedNoMips = $2;
                        globalThis.__omwTexStats = s;
                    }, sTotal, sCompressed, sCompressedNoMips);
                    // clang-format on
                }
            }
#endif
            mCache->addEntryToObjectCache(path.value(), image);
            return image;
        }
    }

    osg::Image* ImageManager::getWarningImage()
    {
        return mWarningImage;
    }

    void ImageManager::reportStats(unsigned int frameNumber, osg::Stats* stats) const
    {
        Resource::reportStats("Image", frameNumber, mCache->getStats(), *stats);
    }

}
