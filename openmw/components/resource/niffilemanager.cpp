#include "niffilemanager.hpp"

#include <iostream>

#include <osg/Object>

#include <components/debug/debuglog.hpp>
#include <components/nif/cleanup.hpp>
#include <components/vfs/manager.hpp>

#include "objectcache.hpp"
#include "nifstats.hpp"

namespace Resource
{

    class NifFileHolder : public osg::Object
    {
    public:
        NifFileHolder(const Nif::NIFFilePtr& file)
            : mNifFile(file)
        {
        }
        NifFileHolder(const NifFileHolder& copy, const osg::CopyOp& copyop)
            : mNifFile(copy.mNifFile)
        {
        }

        NifFileHolder() = default;

        META_Object(Resource, NifFileHolder)

        Nif::NIFFilePtr mNifFile;
    };

    std::atomic_bool NifFileManager::sMeshCleanup{ false };

    NifFileManager::NifFileManager(const VFS::Manager* vfs, const ToUTF8::StatelessUtf8Encoder* encoder)
        // NIF files aren't needed any more once the converted objects are cached in SceneManager / BulletShapeManager,
        // so no point in using an expiry delay.
        : ResourceManager(vfs, 0)
        , mEncoder(encoder)
    {
    }

    NifFileManager::~NifFileManager() = default;

    Nif::NIFFilePtr NifFileManager::get(VFS::Path::NormalizedView name)
    {
        osg::ref_ptr<osg::Object> obj = mCache->getRefFromObjectCache(name);
        if (obj != nullptr)
            return static_cast<NifFileHolder*>(obj.get())->mNifFile;

        auto file = std::make_shared<Nif::NIFFile>(name);
        Nif::Reader reader(*file, mEncoder);
        OPENMW_NIF_STAT_BEGIN(nifStatBegin);
        reader.parse(mVFS->get(name));
        OPENMW_NIF_STAT_END(Resource::NifStage::Parse, nifStatBegin);
        if (sMeshCleanup)
        {
            const Nif::CleanupStats stats = Nif::cleanupFile(*file);
            if (stats.total() != 0)
                Log(Debug::Verbose) << "Mesh cleanup " << name.value() << ": " << stats.mDegenerateTriangles
                                    << " degenerate triangles, " << stats.mEmptyShapes << " empty shapes, "
                                    << stats.mEmptyNodes << " empty nodes, " << stats.mRedundantProperties
                                    << " redundant properties";
        }
        obj = new NifFileHolder(file);
        mCache->addEntryToObjectCache(name.value(), obj);
        return file;
    }

    void NifFileManager::reportStats(unsigned int frameNumber, osg::Stats* stats) const
    {
        Resource::reportStats("Nif", frameNumber, mCache->getStats(), *stats);
    }

}
