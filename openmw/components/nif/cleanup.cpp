#include "cleanup.hpp"

#include <algorithm>
#include <unordered_map>

#include "base.hpp"
#include "controller.hpp"
#include "data.hpp"
#include "effect.hpp"
#include "niffile.hpp"
#include "node.hpp"
#include "property.hpp"

namespace Nif
{
    namespace
    {
        bool cleanTriangles(NiTriShapeData& data, CleanupStats& stats)
        {
            std::vector<unsigned short>& tris = data.mTriangles;
            const std::size_t numVerts = data.mVertices.size();
            std::size_t out = 0;
            const std::size_t whole = tris.size() - tris.size() % 3;
            for (std::size_t i = 0; i < whole; i += 3)
            {
                const unsigned short a = tris[i], b = tris[i + 1], c = tris[i + 2];
                bool keep = a != b && b != c && a != c && a < numVerts && b < numVerts && c < numVerts;
                if (keep)
                {
                    const osg::Vec3f& va = data.mVertices[a];
                    const osg::Vec3f& vb = data.mVertices[b];
                    const osg::Vec3f& vc = data.mVertices[c];
                    keep = !(va == vb || vb == vc || va == vc);
                }
                if (!keep)
                {
                    ++stats.mDegenerateTriangles;
                    continue;
                }
                tris[out++] = a;
                tris[out++] = b;
                tris[out++] = c;
            }
            const bool changed = out != tris.size();
            tris.resize(out);
            data.mNumTriangles = static_cast<uint16_t>(out / 3);
            return changed;
        }

        bool hasAttachments(const NiAVObject& obj)
        {
            return !obj.mController.empty() || !obj.mExtra.empty() || !obj.mExtraList.empty()
                || !obj.mCollision.empty() || obj.mIsBone;
        }

        bool isRemovable(const NiAVObject& obj)
        {
            if (hasAttachments(obj))
                return false;
            if (obj.mRecordType == RC_NiTriShape)
            {
                const auto& shape = static_cast<const NiTriShape&>(obj);
                if (!shape.mSkin.empty())
                    return false;
                if (shape.mData.empty())
                    return true;
                const auto& data = static_cast<const NiTriShapeData&>(shape.mData.get());
                return data.mTriangles.empty();
            }
            if (obj.mRecordType == RC_NiNode)
            {
                const auto& node = static_cast<const NiNode&>(obj);
                if (!obj.mName.empty())
                    return false;
                if (!node.mEffects.empty())
                    return false;
                return std::all_of(node.mChildren.begin(), node.mChildren.end(), [](const auto& c) { return c.empty(); });
            }
            return false;
        }

        // Which property record of each type is in effect on the way down.
        using Effective = std::unordered_map<int, const NiProperty*>;

        void dedupeProperties(NiAVObject& obj, Effective& effective, CleanupStats& stats)
        {
            auto& props = obj.mProperties;
            props.erase(std::remove_if(props.begin(), props.end(),
                            [&](const RecordPtrT<NiProperty>& p) {
                                if (p.empty() || p->mRecordType == RC_NiTexturingProperty || !p->mController.empty())
                                    return false;
                                auto it = effective.find(p->mRecordType);
                                if (it == effective.end() || it->second != p.getPtr())
                                    return false;
                                ++stats.mRedundantProperties;
                                return true;
                            }),
                props.end());
            for (const auto& p : props)
                if (!p.empty())
                    effective[p->mRecordType] = p.getPtr();
        }

        void walk(NiAVObject& obj, Effective effective, bool mayRemoveNodes, CleanupStats& stats)
        {
            dedupeProperties(obj, effective, stats);

            if (obj.mRecordType != RC_NiNode && obj.mRecordType != RC_RootCollisionNode)
            {
                // Other node types (switch, LOD, billboard...) still get their subtree cleaned,
                // but never lose a child: some of them address children by index.
                if (auto* node = dynamic_cast<NiNode*>(&obj))
                    for (auto& child : node->mChildren)
                        if (!child.empty())
                            walk(child.get(), effective, mayRemoveNodes, stats);
                return;
            }

            auto& node = static_cast<NiNode&>(obj);
            for (auto& child : node.mChildren)
                if (!child.empty())
                    walk(child.get(), effective, mayRemoveNodes, stats);

            if (!mayRemoveNodes)
                return;

            auto& children = node.mChildren;
            children.erase(std::remove_if(children.begin(), children.end(),
                               [&](NiAVObjectPtr& child) {
                                   if (child.empty() || !isRemovable(child.get()))
                                       return false;
                                   // A node with two parents stays: the other one still draws it.
                                   if (child->mParents.size() > 1)
                                       return false;
                                   if (child->mRecordType == RC_NiTriShape)
                                       ++stats.mEmptyShapes;
                                   else
                                       ++stats.mEmptyNodes;
                                   auto& parents = child->mParents;
                                   parents.erase(std::remove(parents.begin(), parents.end(), &node), parents.end());
                                   return true;
                               }),
                children.end());
        }

        bool fileHasOutsidePointers(const NIFFile& file)
        {
            for (const auto& rec : file.mRecords)
            {
                const Record* r = rec.get();
                if (r == nullptr)
                    continue;
                if (dynamic_cast<const NiTimeController*>(r) || dynamic_cast<const NiDynamicEffect*>(r)
                    || dynamic_cast<const NiParticles*>(r) || r->mRecordType == RC_NiSkinInstance)
                    return true;
            }
            return false;
        }
    }

    CleanupStats cleanupFile(NIFFile& file)
    {
        CleanupStats stats;
        if (file.mVersion > NIFFile::VER_MW)
            return stats;

        for (const auto& rec : file.mRecords)
            if (rec && rec->mRecordType == RC_NiTriShapeData)
                cleanTriangles(static_cast<NiTriShapeData&>(*rec), stats);

        const bool mayRemoveNodes = !fileHasOutsidePointers(file);
        for (Record* root : file.mRoots)
            if (auto* obj = dynamic_cast<NiAVObject*>(root))
                walk(*obj, Effective(), mayRemoveNodes, stats);
        return stats;
    }
}
