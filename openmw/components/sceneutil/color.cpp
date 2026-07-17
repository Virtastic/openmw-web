// Modified by Virtastic (https://virtastic.app) for the OpenMW-Web port, 2025-2026.
// See WASM_ADAPTATIONS.md at the repository root for details of the changes.
#include "color.hpp"

#include <algorithm>
#include <array>

namespace SceneUtil
{

    bool isColorFormat(GLenum format)
    {
        static constexpr std::array<GLenum, 42> formats = {
            GL_RGB,
            GL_RGB4,
            GL_RGB5,
            GL_RGB8,
            GL_RGB8_SNORM,
            GL_RGB10,
            GL_RGB12,
            GL_RGB16,
            GL_RGB16_SNORM,
            GL_SRGB,
            GL_SRGB8,
            GL_RGB16F,
            GL_RGB32F,
            GL_R11F_G11F_B10F,
            GL_RGB9_E5,
            GL_RGB8I,
            GL_RGB8UI,
            GL_RGB16I,
            GL_RGB16UI,
            GL_RGB32I,
            GL_RGB32UI,
            GL_RGBA,
            GL_RGBA2,
            GL_RGBA4,
            GL_RGB5_A1,
            GL_RGBA8,
            GL_RGBA8_SNORM,
            GL_RGB10_A2,
            GL_RGB10_A2UI,
            GL_RGBA12,
            GL_RGBA16,
            GL_RGBA16_SNORM,
            GL_SRGB_ALPHA8,
            GL_SRGB8_ALPHA8,
            GL_RGBA16F,
            GL_RGBA32F,
            GL_RGBA8I,
            GL_RGBA8UI,
            GL_RGBA16I,
            GL_RGBA16UI,
            GL_RGBA32I,
            GL_RGBA32UI,
        };

        return std::find(formats.cbegin(), formats.cend(), format) != formats.cend();
    }

    bool isFloatingPointColorFormat(GLenum format)
    {
        static constexpr std::array<GLenum, 5> formats = {
            GL_RGB16F,
            GL_RGB32F,
            GL_R11F_G11F_B10F,
            GL_RGBA16F,
            GL_RGBA32F,
        };

        return std::find(formats.cbegin(), formats.cend(), format) != formats.cend();
    }

    int getColorFormatChannelCount(GLenum format)
    {
        static constexpr std::array<GLenum, 21> formats = {
            GL_RGBA,
            GL_RGBA2,
            GL_RGBA4,
            GL_RGB5_A1,
            GL_RGBA8,
            GL_RGBA8_SNORM,
            GL_RGB10_A2,
            GL_RGB10_A2UI,
            GL_RGBA12,
            GL_RGBA16,
            GL_RGBA16_SNORM,
            GL_SRGB_ALPHA8,
            GL_SRGB8_ALPHA8,
            GL_RGBA16F,
            GL_RGBA32F,
            GL_RGBA8I,
            GL_RGBA8UI,
            GL_RGBA16I,
            GL_RGBA16UI,
            GL_RGBA32I,
            GL_RGBA32UI,
        };
        if (std::find(formats.cbegin(), formats.cend(), format) != formats.cend())
            return 4;
        return 3;
    }

    void getColorFormatSourceFormatAndType(GLenum internalFormat, GLenum& sourceFormat, GLenum& sourceType)
    {
        if (getColorFormatChannelCount(internalFormat) == 4)
            sourceFormat = GL_RGBA;
        else
            sourceFormat = GL_RGB;

        if (isFloatingPointColorFormat(internalFormat))
            sourceType = GL_FLOAT;
        else
            sourceType = GL_UNSIGNED_BYTE;
    }

    namespace Color
    {
        GLenum sColorInternalFormat;
        GLenum sColorSourceFormat;
        GLenum sColorSourceType;

        GLenum colorInternalFormat()
        {
            return sColorInternalFormat;
        }

        GLenum colorSourceFormat()
        {
            return sColorSourceFormat;
        }

        GLenum colorSourceType()
        {
            return sColorSourceType;
        }

        void SelectColorFormatOperation::operator()([[maybe_unused]] osg::GraphicsContext* graphicsContext)
        {
#ifdef __EMSCRIPTEN__
            // WebGL2: unsized GL_RGB/UNSIGNED_BYTE is NOT color-renderable as an FBO attachment ->
            // GL_FRAMEBUFFER_INCOMPLETE_ATTACHMENT (0x8cd6). mSupportedFormats is never populated
            // (Engine never calls setSupportedFormats), so this default would otherwise stick at
            // GL_RGB and break the water reflection/refraction + localmap RTTs. Use sized RGBA8.
            sColorInternalFormat = GL_RGBA8;
#else
            sColorInternalFormat = GL_RGB;
#endif

            for (auto supportedFormat : mSupportedFormats)
            {
                if (isColorFormat(supportedFormat))
                {
                    sColorInternalFormat = supportedFormat;
                    break;
                }
            }

            getColorFormatSourceFormatAndType(sColorInternalFormat, sColorSourceFormat, sColorSourceType);
        }
    }
}
