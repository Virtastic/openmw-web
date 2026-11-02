#include <components/nif/cleanup.hpp>
#include <components/nif/controller.hpp>
#include <components/nif/data.hpp>
#include <components/nif/node.hpp>
#include <components/nif/property.hpp>

#include <gtest/gtest.h>

#include "node.hpp"

namespace Nif
{
    namespace
    {
        using namespace testing;

        constexpr VFS::Path::NormalizedView path("test.nif");

        // Builds a small MW-version file. Records are owned by the file, like the reader does.
        struct NifCleanupTest : Test
        {
            NIFFile mFile{ path };

            NifCleanupTest() { mFile.mVersion = NIFFile::VER_MW; }

            template <class T>
            T& add(RecordType type)
            {
                auto rec = std::make_unique<T>();
                T& ref = *rec;
                rec->mRecordType = type;
                rec->mRecordIndex = static_cast<unsigned>(mFile.mRecords.size());
                mFile.mRecords.push_back(std::move(rec));
                return ref;
            }

            void initAV(NiAVObject& obj)
            {
                Testing::init(obj);
                obj.mCollision = NiCollisionObjectPtr(nullptr);
            }

            NiNode& node(std::string name = {})
            {
                NiNode& n = add<NiNode>(RC_NiNode);
                initAV(n);
                n.mName = std::move(name);
                return n;
            }

            NiTriShapeData& data(std::vector<osg::Vec3f> verts, std::vector<unsigned short> tris)
            {
                NiTriShapeData& d = add<NiTriShapeData>(RC_NiTriShapeData);
                d.mVertices = std::move(verts);
                d.mNumVertices = static_cast<uint16_t>(d.mVertices.size());
                d.mTriangles = std::move(tris);
                d.mNumTriangles = static_cast<uint16_t>(d.mTriangles.size() / 3);
                return d;
            }

            NiTriShape& shape(NiTriShapeData* d)
            {
                NiTriShape& s = add<NiTriShape>(RC_NiTriShape);
                Testing::init(s);
                s.mCollision = NiCollisionObjectPtr(nullptr);
                s.mData = NiGeometryDataPtr(d);
                return s;
            }

            static void attach(NiNode& parent, NiAVObject& child)
            {
                parent.mChildren.emplace_back(&child);
                child.mParents.push_back(&parent);
            }

            static const std::vector<osg::Vec3f> quad()
            {
                return { { 0, 0, 0 }, { 1, 0, 0 }, { 1, 1, 0 }, { 0, 1, 0 } };
            }
        };

        TEST_F(NifCleanupTest, keepsCleanGeometryUntouched)
        {
            NiNode& root = node("root");
            NiTriShapeData& d = data(quad(), { 0, 1, 2, 0, 2, 3 });
            attach(root, shape(&d));
            mFile.mRoots.push_back(&root);

            const CleanupStats stats = cleanupFile(mFile);
            EXPECT_EQ(stats.total(), 0u);
            EXPECT_EQ(d.mTriangles, (std::vector<unsigned short>{ 0, 1, 2, 0, 2, 3 }));
            EXPECT_EQ(root.mChildren.size(), 1u);
        }

        TEST_F(NifCleanupTest, dropsDegenerateAndOutOfRangeTriangles)
        {
            NiNode& root = node("root");
            std::vector<osg::Vec3f> v = quad();
            v.push_back({ 1, 0, 0 }); // 4: same position as 1
            NiTriShapeData& d = data(v, { 0, 1, 2, /*repeat*/ 0, 0, 1, /*range*/ 0, 2, 9, /*coincident*/ 1, 4, 2, 0, 2, 3 });
            attach(root, shape(&d));
            mFile.mRoots.push_back(&root);

            const CleanupStats stats = cleanupFile(mFile);
            EXPECT_EQ(stats.mDegenerateTriangles, 3u);
            EXPECT_EQ(d.mTriangles, (std::vector<unsigned short>{ 0, 1, 2, 0, 2, 3 }));
            EXPECT_EQ(d.mNumTriangles, 2);
        }

        TEST_F(NifCleanupTest, detachesEmptyShapesAndUnnamedEmptyNodes)
        {
            NiNode& root = node("root");
            NiNode& holder = node(); // becomes empty once its only shape goes
            NiTriShapeData& bad = data(quad(), { 0, 0, 0 });
            NiTriShape& empty = shape(&bad);
            attach(holder, empty);
            attach(root, holder);
            NiTriShapeData& good = data(quad(), { 0, 1, 2 });
            attach(root, shape(&good));
            attach(root, node("AttachLight")); // named: an attach point, kept
            mFile.mRoots.push_back(&root);

            const CleanupStats stats = cleanupFile(mFile);
            EXPECT_EQ(stats.mEmptyShapes, 1u);
            EXPECT_EQ(stats.mEmptyNodes, 1u);
            ASSERT_EQ(root.mChildren.size(), 2u);
            EXPECT_EQ(root.mChildren[0]->mRecordType, RC_NiTriShape);
            EXPECT_EQ(root.mChildren[1]->mName, "AttachLight");
            EXPECT_TRUE(holder.mParents.empty());
        }

        TEST_F(NifCleanupTest, keepsBonesAndNodesWithExtraData)
        {
            NiNode& root = node("root");
            NiNode& bone = node();
            bone.mIsBone = true;
            attach(root, bone);
            mFile.mRoots.push_back(&root);

            EXPECT_EQ(cleanupFile(mFile).mEmptyNodes, 0u);
            EXPECT_EQ(root.mChildren.size(), 1u);
        }

        TEST_F(NifCleanupTest, removesNoNodesInFilesWithControllers)
        {
            NiNode& root = node("root");
            attach(root, node());
            NiKeyframeController& ctrl = add<NiKeyframeController>(RC_NiKeyframeController);
            Testing::init(static_cast<NiTimeController&>(ctrl));
            mFile.mRoots.push_back(&root);

            EXPECT_EQ(cleanupFile(mFile).mEmptyNodes, 0u);
            EXPECT_EQ(root.mChildren.size(), 1u);
        }

        TEST_F(NifCleanupTest, neverRemovesChildrenOfSwitchNodes)
        {
            NiSwitchNode& sw = add<NiSwitchNode>(RC_NiSwitchNode);
            initAV(sw);
            sw.mName = "switch";
            attach(sw, node());
            attach(sw, node());
            mFile.mRoots.push_back(&sw);

            EXPECT_EQ(cleanupFile(mFile).mEmptyNodes, 0u);
            EXPECT_EQ(sw.mChildren.size(), 2u);
        }

        TEST_F(NifCleanupTest, dropsPropertyRepeatedFromAncestor)
        {
            NiMaterialProperty& mat = add<NiMaterialProperty>(RC_NiMaterialProperty);
            mat.mController = NiTimeControllerPtr(nullptr);
            NiMaterialProperty& other = add<NiMaterialProperty>(RC_NiMaterialProperty);
            other.mController = NiTimeControllerPtr(nullptr);

            NiNode& root = node("root");
            root.mProperties.emplace_back(&mat);
            NiNode& mid = node("mid");
            mid.mProperties.emplace_back(&other); // overrides: the leaf's copy of mat is NOT redundant
            NiTriShapeData& d = data(quad(), { 0, 1, 2 });
            NiTriShape& leafA = shape(&d);
            leafA.mProperties.emplace_back(&mat);
            NiTriShape& leafB = shape(&d);
            leafB.mProperties.emplace_back(&mat);
            attach(root, leafA);
            attach(root, mid);
            attach(mid, leafB);
            mFile.mRoots.push_back(&root);

            EXPECT_EQ(cleanupFile(mFile).mRedundantProperties, 1u);
            EXPECT_TRUE(leafA.mProperties.empty());
            EXPECT_EQ(leafB.mProperties.size(), 1u);
        }

        TEST_F(NifCleanupTest, leavesNewerFormatsAlone)
        {
            mFile.mVersion = NIFFile::VER_OB;
            NiNode& root = node("root");
            NiTriShapeData& d = data(quad(), { 0, 0, 1 });
            attach(root, shape(&d));
            mFile.mRoots.push_back(&root);

            EXPECT_EQ(cleanupFile(mFile).total(), 0u);
            EXPECT_EQ(d.mTriangles.size(), 3u);
        }

        TEST_F(NifCleanupTest, isIdempotent)
        {
            NiNode& root = node("root");
            NiTriShapeData& d = data(quad(), { 0, 1, 2, 1, 1, 2 });
            attach(root, shape(&d));
            attach(root, node());
            mFile.mRoots.push_back(&root);

            EXPECT_NE(cleanupFile(mFile).total(), 0u);
            EXPECT_EQ(cleanupFile(mFile).total(), 0u);
        }
    }
}
