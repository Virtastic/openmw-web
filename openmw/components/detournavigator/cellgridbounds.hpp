#ifndef OPENMW_COMPONENTS_DETOURNAVIGATOR_CELLGRIDBOUNDS_H
#define OPENMW_COMPONENTS_DETOURNAVIGATOR_CELLGRIDBOUNDS_H

#include <osg/Vec2i>

namespace DetourNavigator
{
    struct CellGridBounds
    {
        osg::Vec2i mCenter;
        int mHalfSize;

        friend bool operator==(const CellGridBounds& lhs, const CellGridBounds& rhs)
        {
            return lhs.mCenter == rhs.mCenter && lhs.mHalfSize == rhs.mHalfSize;
        }
    };
}

#endif
