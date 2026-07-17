// Modified by Virtastic (https://virtastic.app) for the OpenMW-Web port, 2025-2026.
// See WASM_ADAPTATIONS.md at the repository root for details of the changes.
#include "workqueue.hpp"

#include <algorithm>
#include <cstdlib>

#include <components/debug/debuglog.hpp>

#include <numeric>

namespace SceneUtil
{

    void WorkItem::waitTillDone()
    {
        if (mDone)
            return;

        std::unique_lock<std::mutex> lock(mMutex);
        while (!mDone)
        {
            mCondition.wait(lock);
        }
    }

    void WorkItem::signalDone()
    {
        {
            std::unique_lock<std::mutex> lock(mMutex);
            mDone = true;
        }
        mCondition.notify_all();
    }

    bool WorkItem::isDone() const
    {
        return mDone;
    }

    WorkQueue::WorkQueue(std::size_t workerThreads)
        : mIsReleased(false)
    {
        start(workerThreads);
    }

    WorkQueue::~WorkQueue()
    {
        stop();
    }

    void WorkQueue::start(std::size_t workerThreads)
    {
#ifdef __EMSCRIPTEN__
        // INLINE by default (single-threaded, work runs on the caller — see addWorkItem).
        // Real worker threads were tried (workers do CPU asset prep, GL compile handed to the
        // main thread via the IncrementalCompileOperation) but a worker's getTemplate()/ICO->add()
        // runs concurrently with a MAIN-thread cache-miss getTemplate() (e.g. equipping a fresh
        // weapon). On the single-threaded WebGL2 build a main-thread futex wait on a worker-held
        // mutex (mSharedStateMutex / object cache / ICO) STARVES the browser event loop = hard
        // freeze. So default to inline; OPENMW_WORKQUEUE_THREADED=1 opts back into 2 workers.
        if (getenv("OPENMW_WORKQUEUE_THREADED") != nullptr)
            workerThreads = std::min<std::size_t>(std::max<std::size_t>(workerThreads, 1), 2);
        else
            workerThreads = 1;
#endif
        {
            const std::lock_guard lock(mMutex);
            mIsReleased = false;
        }
        while (mThreads.size() < workerThreads)
            mThreads.emplace_back(std::make_unique<WorkThread>(*this));
    }

    void WorkQueue::stop()
    {
        {
            std::unique_lock<std::mutex> lock(mMutex);
            while (!mQueue.empty())
                mQueue.pop_back();
            mIsReleased = true;
            mCondition.notify_all();
        }

        mThreads.clear();
    }

    void WorkQueue::addWorkItem(osg::ref_ptr<WorkItem> item, bool front)
    {
        if (item->isDone())
        {
            Log(Debug::Error) << "Error: trying to add a work item that is already completed";
            return;
        }

#ifdef __EMSCRIPTEN__
        // Inline by default: run the work on the caller (main thread). Avoids the worker/main
        // getTemplate contention that freezes the browser. OPENMW_WORKQUEUE_THREADED=1 opts into
        // real worker threads (queued below).
        if (getenv("OPENMW_WORKQUEUE_THREADED") == nullptr)
        {
            item->doWork();
            item->signalDone();
            return;
        }
#endif
        std::unique_lock<std::mutex> lock(mMutex);
        if (front)
            mQueue.push_front(std::move(item));
        else
            mQueue.push_back(std::move(item));
        mCondition.notify_one();
    }

    osg::ref_ptr<WorkItem> WorkQueue::removeWorkItem()
    {
        std::unique_lock<std::mutex> lock(mMutex);
        while (mQueue.empty() && !mIsReleased)
        {
            mCondition.wait(lock);
        }
        if (!mQueue.empty())
        {
            osg::ref_ptr<WorkItem> item = std::move(mQueue.front());
            mQueue.pop_front();
            return item;
        }
        return nullptr;
    }

    size_t WorkQueue::getNumItems() const
    {
        std::unique_lock<std::mutex> lock(mMutex);
        return mQueue.size();
    }

    size_t WorkQueue::getNumActiveThreads() const
    {
        return std::accumulate(
            mThreads.begin(), mThreads.end(), 0u, [](auto r, const auto& t) { return r + t->isActive(); });
    }

    WorkThread::WorkThread(WorkQueue& workQueue)
        : mWorkQueue(&workQueue)
        , mActive(false)
        , mThread([this] { run(); })
    {
    }

    WorkThread::~WorkThread()
    {
        mThread.join();
    }

    void WorkThread::run()
    {
        while (true)
        {
            osg::ref_ptr<WorkItem> item = mWorkQueue->removeWorkItem();
            if (!item)
                return;
            mActive = true;
            item->doWork();
            item->signalDone();
            mActive = false;
        }
    }

    bool WorkThread::isActive() const
    {
        return mActive;
    }

}
