import {describe} from 'ava-spec';

import Queue from '../lib/queue';
import helpers from '../lib/helpers';
import sinon from 'sinon';

import {promisify} from 'promise-callbacks';

import redis from '../lib/redis';
import {createClient} from 'redis';
import {Cluster} from 'ioredis';

// A promise-based barrier.
function reef(n = 1) {
  const done = helpers.deferred(), end = done.defer();
  return {
    done,
    next() {
      --n;
      if (n < 0) return false;
      if (n === 0) end();
      return true;
    }
  };
}

async function recordUntil(emitter, trackedEvents, lastEvent) {
  const recordedEvents = [];

  const done = helpers.waitOn(emitter, lastEvent);
  for (let event of trackedEvents) {
    const handler = (...values) => {
      recordedEvents.push([event, ...values]);
    };
    emitter.on(event, handler);
    done.then(() => emitter.removeListener(event, handler));
  }

  await done;
  return recordedEvents;
}

function delKeys(client, pattern) {
  const promise = helpers.deferred(), done = promise.defer();
  client.keys(pattern, (err, keys) => {
    if (err) return done(err);
    if (keys.length) {
      client.del(keys, done);
    } else {
      done();
    }
  });
  return promise;
}

function spitter() {
  const values = [], resume = [];

  function push(value) {
    if (resume.length) {
      resume.shift()(value);
    } else {
      values.push(value);
    }
  }

  return {
    push,
    pushSuspend(value) {
      return new Promise((resolve) => push([value, resolve]));
    },
    count() {
      return values.length;
    },
    shift() {
      if (values.length) {
        return Promise.resolve(values.shift());
      }
      return new Promise((resolve) => resume.push(resolve));
    }
  };
}

describe('Queue', (it) => {
  const gclient = redis.createClient();

  it.before(() => gclient);

  let uid = 0;
  it.beforeEach((t) => {
    const ctx = t.context;

    Object.assign(ctx, {
      queueName: `test-queue-${uid++}`,
      queues: [],
      queueErrors: [],
      makeQueue,
      handleErrors,
    });

    function makeQueue(...args) {
      const queue = new Queue(ctx.queueName, ...args);
      queue.on('error', (err) => ctx.queueErrors.push(err));
      ctx.queues.push(queue);
      return queue;
    }

    function handleErrors(t) {
      if (t) return t.notThrows(handleErrors);
      if (ctx.queueErrors && ctx.queueErrors.length) {
        throw ctx.queueErrors[0];
      }
    }
  });

  it.afterEach((t) => {
    const errs = t.context.queueErrors;
    if (errs && errs.length) {
      t.fail('errors were not cleaned up');
    }

    // Close all the queues that were created during the test, and wait for them to close before
    // ending the test.
    if (t.context.queues) {
      return Promise.all(t.context.queues.map((queue) => {
        if (!queue.paused) {
          return queue.close();
        }
      }));
    }
  });

  it.beforeEach(async (t) => delKeys(await gclient, `bq:${t.context.queueName}:*`));
  it.afterEach(async (t) => delKeys(await gclient, `bq:${t.context.queueName}:*`));

  it('should initialize without ensuring scripts', async (t) => {
    const queue = t.context.makeQueue({
      ensureScripts: false
    });

    await queue.ready();

    t.context.handleErrors(t);
  });

  it.cb('should support a ready callback', (t) => {
    const queue = t.context.makeQueue();
    queue.ready(t.end);
  });

  it('should indicate whether it is running', async (t) => {
    const queue = t.context.makeQueue();

    // The queue should be "running" immediately - different from ready because it can accept jobs
    // immediately.
    t.true(queue.isRunning());
    await queue.ready();
    t.true(queue.isRunning());
    await queue.close();
    t.false(queue.isRunning());
  });

  it.describe('Connection', (it) => {
    it.describe('Close', (it) => {
      it('should close the redis clients', async (t) => {
        const queue = t.context.makeQueue();

        await queue.ready();

        t.true(redis.isReady(queue.client));
        t.true(redis.isReady(queue.bclient));
        t.true(redis.isReady(queue.eclient));

        await queue.close();

        // ioredis closes the connection some time after the quit response has
        // been received.
        await Promise.all([
          redis.isReady(queue.client) && helpers.waitOn(queue.client, 'close'),
          redis.isReady(queue.bclient) && helpers.waitOn(queue.bclient, 'close'),
          redis.isReady(queue.eclient) && helpers.waitOn(queue.eclient, 'close'),
        ]);

        t.false(redis.isReady(queue.client));
        t.false(redis.isReady(queue.eclient));
      });

      it.cb('should support callbacks', (t) => {
        const queue = t.context.makeQueue();

        queue.ready().then(() => {
          queue.close(t.end);
        }).catch(t.end);
      });

      it('should not fail after a second call', async (t) => {
        const queue = t.context.makeQueue();

        await queue.ready();

        await queue.close();
        await t.notThrows(queue.close());
      });

      it('should stop processing even with a redis retry strategy', async (t) => {
        const queue = t.context.makeQueue({
          redis: {
            // Retry after 1 millisecond.
            retryStrategy: () => 1
          }
        });

        const processSpy = sinon.spy(async () => {});
        queue.process(processSpy);

        await queue.createJob({is: 'first'}).save();
        await helpers.waitOn(queue, 'succeeded', true);
        t.true(processSpy.calledOnce);
        processSpy.reset();

        // Close the queue so queue3 will process later jobs.
        queue.close();

        const queue2 = t.context.makeQueue({
          // If the other queue is still somehow running, ensure that we can't take work from it.
          isWorker: false
        });

        await queue2.createJob({is: 'second'}).save();
        await helpers.delay(50);

        const queue3 = t.context.makeQueue();

        const newSpy = sinon.spy(async () => {});
        queue3.process(newSpy);

        await helpers.waitOn(queue3, 'succeeded', true);
        await queue3.close();

        t.true(newSpy.calledOnce);
        t.false(processSpy.called);
      });

      it('should gracefully shut down', async (t) => {
        const queue = t.context.makeQueue();

        const started = helpers.deferred(), resume = helpers.deferred();
        queue.process(() => {
          setImmediate(started.defer(), null);
          return resume;
        });

        const successSpy = sinon.spy();
        queue.on('succeeded', successSpy);

        await queue.createJob({}).save();
        await started;

        // Asynchronously wait 20 seconds, then complete the process handler.
        setTimeout(resume.defer(), 20, null);

        // Meanwhile, close the queue, and verify that success is called before close completes.
        t.false(successSpy.called);
        await queue.close();
        t.true(successSpy.calledOnce);
      });

      it('should not process new jobs while shutting down', async (t) => {
        const queue = t.context.makeQueue();

        const started = helpers.deferred(),
              resumed = helpers.deferred(), resume = resumed.defer();
        const processSpy = sinon.spy(() => {
          setImmediate(started.defer(), null);
          return resumed;
        });
        queue.process(processSpy);

        const successSpy = sinon.spy();
        queue.on('succeeded', successSpy);

        await queue.createJob({is: 'first'}).save();
        await started;

        // Close the queue, save a new job, and then complete the first job.
        const closed = queue.close();
        await queue.createJob({is: 'second'}).save();
        resume(null);
        await closed;

        // Verify that the second job wasn't picked up for processing.
        t.true(processSpy.calledOnce);
        t.true(successSpy.calledOnce);
        t.deepEqual(processSpy.firstCall.args[0].data, {is: 'first'});
      });

      it('should stop the check timer', async (t) => {
        const queue = t.context.makeQueue({
          stallInterval: 100
        });

        queue.checkStalledJobs(50);

        await helpers.delay(25);

        const spy = sinon.spy(queue, 'checkStalledJobs');
        await queue.close();

        await helpers.delay(50);

        t.false(spy.called);
      });

      it('should time out', async (t) => {
        const queue = t.context.makeQueue();

        // Intentionally stall the job.
        const jobs = spitter();
        queue.process((job) => jobs.pushSuspend(job));

        await queue.createJob({}).save();
        await jobs.shift();

        await t.throws(queue.close(10), 'Operation timed out.');
      });

      it('should not time out when a job fails', async (t) => {
        const queue = t.context.makeQueue();

        const jobs = spitter();
        queue.process((job) => jobs.pushSuspend(job));

        await queue.createJob({}).save();
        const [, finishJob] = await jobs.shift();

        process.nextTick(finishJob, new Error('fails the job'));
        await t.notThrows(queue.close(1000));
      });

      it('should error if a job completes after the timeout', async (t) => {
        const queue = t.context.makeQueue();

        const jobs = spitter();
        queue.process((job) => jobs.pushSuspend(job));

        await queue.createJob({}).save();
        const [, finishJob] = await jobs.shift();

        await t.throws(queue.close(10));
        finishJob(null);

        await helpers.delay(5);

        const errors = t.context.queueErrors, count = errors.length;
        t.context.queueErrors = errors.filter((err) => {
          return err.message !== 'unable to update the status of succeeded job 1';
        });
        t.is(t.context.queueErrors.length, count - 1);
        t.context.handleErrors(t);
      });

      it('should not error on close', async (t) => {
        const queue = t.context.makeQueue();

        await queue.close();

        await helpers.delay(30);

        t.context.handleErrors(t);
      });

      it('should not interfere with checkStalledJobs', async (t) => {
        const queue = t.context.makeQueue();

        await queue.checkStalledJobs(10);
        await queue.close();

        await helpers.delay(50);

        t.context.handleErrors(t);
      });

      it('should not quit the command client by default if given in settings', async (t) => {
        const client = await redis.createClient();

        sinon.spy(client, 'quit');

        let queue = t.context.makeQueue({
          redis: client
        });

        await queue.close();

        t.true(client.ready);
        t.false(client.quit.called);

        let promise = helpers.deferred();
        client.ping(promise.defer());
        await t.notThrows(promise);

        queue = t.context.makeQueue({
          redis: client,
          quitCommandClient: true
        });

        await queue.close();

        t.false(client.ready);
        t.true(client.quit.called);

        promise = helpers.deferred();
        client.ping(promise.defer());
        await t.throws(promise, (err) => redis.isAbortError(err));
      });

      it('should not quit the command client when quitCommandClient=false', async (t) => {
        const queue = t.context.makeQueue({
          quitCommandClient: false
        });

        await queue.ready();

        const client = queue.client;
        sinon.spy(client, 'quit');

        await queue.close();

        t.true(client.ready);
        t.false(client.quit.called);

        let promise = helpers.deferred();
        client.ping(promise.defer());
        await t.notThrows(promise);

        promise = helpers.deferred();
        client.quit(promise.defer());
        await promise;
      });
    });

    it('should recover from a connection loss', async (t) => {
      const queue = t.context.makeQueue({
        redis: {
          // Retry after 1 millisecond.
          retryStrategy: () => 1
        }
      });

      const jobSpy = sinon.spy(queue, '_getNextJob');

      queue.process(async (job) => {
        t.is(job.data.foo, 'bar');

        // First getNextJob fails on the disconnect, second should succeed.
        t.is(jobSpy.callCount, 2);
      });

      // Not called at all yet because queue.process uses setImmediate.
      t.is(jobSpy.callCount, 0);

      // Override _waitForJob.
      const waitJob = queue._waitForJob, wait = helpers.deferred();
      let waitDone = wait.defer();
      queue._waitForJob = function (...args) {
        if (waitDone) {
          waitDone();
          waitDone = null;
        }
        return waitJob.apply(this, args);
      };

      await wait;

      const errored = helpers.waitOn(queue, 'error');

      queue.bclient.stream.destroy();

      const err = await errored;
      t.true(redis.isAbortError(err));

      queue.createJob({foo: 'bar'}).save();

      await helpers.waitOn(queue, 'succeeded', true);

      t.is(jobSpy.callCount, 2);

      t.context.queueErrors = t.context.queueErrors.filter((e) => e !== err);
    });
  });

  it.describe('Constructor', (it) => {
    it('creates a queue with default redis settings', async (t) => {
      const queue = t.context.makeQueue();

      await queue.ready();

      t.is(queue.client.connection_options.host, '127.0.0.1');
      t.is(queue.bclient.connection_options.host, '127.0.0.1');
      t.is(queue.client.connection_options.port, 6379);
      t.is(queue.bclient.connection_options.port, 6379);
      t.true(queue.client.selected_db == null);
      t.true(queue.bclient.selected_db == null);
    });

    it('creates a queue with passed redis settings', async (t) => {
      const queue = t.context.makeQueue({
        redis: {
          host: 'localhost',
          db: 1
        }
      });

      await queue.ready();

      t.is(queue.client.connection_options.host, 'localhost');
      t.is(queue.bclient.connection_options.host, 'localhost');
      t.is(queue.client.selected_db, 1);
      t.is(queue.bclient.selected_db, 1);
    });

    it('creates a queue with isWorker false', async (t) => {
      const queue = t.context.makeQueue({
        isWorker: false
      });

      await queue.ready();

      t.is(queue.client.connection_options.host, '127.0.0.1');
      t.is(queue.bclient, null);
    });

    it('should create a Queue with an existing redis instance', async (t) => {
      const client = await redis.createClient();

      const queue = t.context.makeQueue({
        redis: client
      });

      await queue.createJob().save();

      t.is(queue.client, client);
      t.not(queue.eclient, client);

      await queue.close();

      t.true(client.ready);
      t.false(queue.eclient.ready);
    });

    it('should create a Queue with a connecting redis instance', async (t) => {
      const client = createClient();

      const queue = t.context.makeQueue({
        redis: client
      });

      await t.notThrows(queue.createJob().save());
    });

    it('should create a Queue with an existing ioredis cluster instance', async (t) => {
      const client = new Cluster([{port: 30001}, {port: 30002}]);

      t.true(redis.isCluster(client));
      t.false(redis.isCluster());
      t.false(redis.isCluster(await redis.createClient()));

      const queue = t.context.makeQueue({
        redis: client
      });

      t.is(queue.settings.keyPrefix, `bq:{${t.context.queueName}}:`);

      await queue.createJob().save();

      t.is(queue.client, client);
      t.not(queue.eclient, client);

      await queue.close();

      t.true(redis.isReady(client));
      t.false(redis.isReady(queue.eclient));
    });
  });

  it('adds a job with correct prefix', async (t) => {
    const queue = t.context.makeQueue();

    await queue.ready();

    const {hget} = promisify.methods(queue.client, ['hget']);

    const job = await queue.createJob({foo: 'bar'}).save();
    t.truthy(job.id);

    const jobData = await hget(`bq:${t.context.queueName}:jobs`, job.id);

    t.is(jobData, job.toData());
  });

  it.describe('Health Check', (it) => {
    it('reports a waiting job', async (t) => {
      const queue = t.context.makeQueue({
        isWorker: false
      });

      const job = await queue.createJob({foo: 'bar'}).save();

      t.truthy(job.id);

      const counts = await queue.checkHealth();

      t.is(counts.waiting, 1);
    });

    it('reports an active job', async (t) => {
      const queue = t.context.makeQueue();
      const end = helpers.deferred(), finish = end.defer();

      queue.process(async (job) => {
        t.is(job.data.foo, 'bar');
        const counts = await queue.checkHealth();
        t.is(counts.active, 1);

        finish();
      });

      const job = await queue.createJob({foo: 'bar'}).save();
      t.truthy(job.id);

      return end;
    });

    it('reports a succeeded job', async (t) => {
      const queue = t.context.makeQueue();

      queue.process(async (job) => {
        t.is(job.data.foo, 'bar');
      });

      const job = await queue.createJob({foo: 'bar'}).save();
      t.truthy(job.id);

      const succeededJob = await helpers.waitOn(queue, 'succeeded');
      t.is(succeededJob.id, job.id);

      const counts = await queue.checkHealth();
      t.is(counts.succeeded, 1);
    });

    it('reports a failed job', async (t) => {
      const queue = t.context.makeQueue();

      queue.process(async (job) => {
        t.is(job.data.foo, 'bar');
        throw new Error('failed!');
      });

      const job = await queue.createJob({foo: 'bar'}).save();
      t.truthy(job.id);

      const failedJob = await helpers.waitOn(queue, 'failed');
      t.is(failedJob.id, job.id);

      const counts = await queue.checkHealth();
      t.is(counts.failed, 1);
    });

    it('should not report the latest job for custom job ids', async (t) => {
      const queue = t.context.makeQueue();

      await queue.createJob({}).setId('noot').save();

      const counts = await queue.checkHealth();
      t.is(counts.newestJob, 0);
    });

    it('should support callbacks', async (t) => {
      const queue = t.context.makeQueue();

      await queue.createJob({foo: 'bar'}).save();

      const countsPromise = helpers.deferred();
      queue.checkHealth(countsPromise.defer());
      const counts = await countsPromise;

      t.is(counts.waiting, 1);
    });
  });

  it.describe('getJobs', (it) => {
    it('gets waiting jobs', async (t) => {
      const queue = t.context.makeQueue();

      const job = await queue.createJob({foo: 'bar'}).save();
      const jobs = await queue.getJobs('waiting', {start: 0, end: 2});
      t.deepEqual(jobs[0].id, job.id);
    });

    it('gets active jobs', async (t) => {
      const queue = t.context.makeQueue();

      await queue.createJob({foo: 'bar'}).save();

      queue.process(async (job) => {
        const jobs = await queue.getJobs('active', {start: 0, end: 100});
        t.is(jobs[0].id, job.id);
      });

      await helpers.waitOn(queue, 'succeeded', true);
    });

    it('gets delayed jobs', async (t) => {
      const queue = t.context.makeQueue();

      queue.process(async () => {});

      const job = await queue.createJob({foo: 'bar'})
        .delayUntil(Date.now() + 10000)
        .save();

      const jobs = await queue.getJobs('delayed', {start: 0, end: 1});
      t.is(jobs[0].id, job.id);
    });

    it('gets failed jobs', async (t) => {
      const queue = t.context.makeQueue();

      const job = await queue.createJob({foo: 'bar'}).save();

      queue.process(async () => {
        throw new Error('failed');
      });

      await helpers.waitOn(queue, 'failed', true);

      const jobs = await queue.getJobs('failed', {size: 1});
      t.is(jobs[0].id, job.id);
    });

    it('gets successful jobs', async (t) => {
      const queue = t.context.makeQueue();

      queue.process(async () => {});

      const job = await queue.createJob({foo: 'bar'}).save();

      await helpers.waitOn(queue, 'succeeded', true);

      const jobs = await queue.getJobs('succeeded', {size: 1});
      t.is(jobs[0].id, job.id);
    });

    // TODO: Speed up this test - there must be a better and more reliable way
    // to avoid encoding the set as an intset in Redis.
    it('scans until "size" jobs are found in for set types', async (t) => {
      const queue = t.context.makeQueue({
        redisScanCount: 50,
        sendEvents: false,
        getEvents: false,
        storeJobs: false
      });

      // Choose a big number for numbers of jobs created, because otherwise the
      // set will be encoded as an intset and SSCAN will ignore the COUNT param.
      // https://redis.io/commands/scan#the-count-option
      const allJobs = new Array(10000).fill().map(() => queue.createJob({foo: 'bar'}));
      await Promise.all(allJobs.map((job) => job.save()));

      // Wait for all jobs to process to make sure the SET encoding is a hash table
      // rather than an intset.
      const {done, next} = reef(allJobs.length);
      queue.process(async () => {
        next();
      });
      await done;

      const jobs = await queue.getJobs('succeeded', {size: 80});

      // Remove duplicates
      t.is(new Set(jobs.map((job) => job.id)).size, 80);
    });

    it('accepts start, end parameters for list and zset types', async (t) => {
      const queue = t.context.makeQueue();

      await t.notThrows(queue.getJobs('waiting', {start: 0, end: 10}));
    });

    it('accepts size parameter for set types', async (t) => {
      const queue = t.context.makeQueue();

      await t.notThrows(queue.getJobs('succeeded', {size: 10}));
    });

    it('rejects improper queue type', async (t) => {
      const queue = t.context.makeQueue();

      await t.throws(queue.getJobs('not-a-queue-type'), /improper queue type/i);
    });

    it('should support callbacks', async (t) => {
      const queue = t.context.makeQueue();

      const job = await queue.createJob({foo: 'bar'}).save();

      let jobsPromise = helpers.deferred();
      queue.getJobs('waiting', {start: 0, end: 1}, jobsPromise.defer());
      let jobs = await jobsPromise;

      t.is(jobs.length, 1);
      t.is(jobs[0].id, job.id);

      jobsPromise = helpers.deferred();
      queue.getJobs('waiting', jobsPromise.defer());
      jobs = await jobsPromise;

      t.is(jobs.length, 1);
      t.is(jobs[0].id, job.id);
    });

    it('uses stored jobs', async (t) => {
      const queue = t.context.makeQueue();

      const job = await queue.createJob({foo: 'bar'}).save();

      const jobs = await queue.getJobs('waiting', {start: 0, end: 1});
      t.is(jobs.length, 1);
      t.is(jobs[0], job);
    });

    it('creates new job instances', async (t) => {
      const queue = t.context.makeQueue({
        storeJobs: false
      });

      const job = await queue.createJob({foo: 'bar'}).save();

      const jobs = await queue.getJobs('waiting', {start: 0, end: 1});
      t.is(jobs.length, 1);
      t.not(jobs[0], job);
    });
  });

  it.describe('getJob', (it) => {
    it('gets an job created by the same queue instance', async (t) => {
      const queue = t.context.makeQueue();

      const createdJob = await queue.createJob({foo: 'bar'}).save();
      t.truthy(createdJob.id);

      const job = await queue.getJob(createdJob.id);
      t.is(job.toData(), createdJob.toData());
    });

    it('should return null for a nonexistent job', async (t) => {
      const queue = t.context.makeQueue();

      const job = await queue.getJob('deadbeef');
      t.is(job, null);
    });

    it('gets a job created by another queue instance', async (t) => {
      const queue = t.context.makeQueue({
        isWorker: false
      });
      const reader = t.context.makeQueue({
        isWorker: false
      });

      const createdJob = await queue.createJob({foo: 'bar'}).save();
      t.truthy(createdJob.id);

      const job = await reader.getJob(createdJob.id);
      t.is(job.toData(), createdJob.toData());
    });

    it('should get a job with a specified id', async (t) => {
      const queue = t.context.makeQueue({
        getEvents: false,
        sendEvents: false,
        storeJobs: false,
      });

      await queue.createJob({foo: 'bar'}).setId('amazingjob').save();

      const job = await queue.getJob('amazingjob');
      t.truthy(job);
      t.is(job.id, 'amazingjob');
      t.deepEqual(job.data, {foo: 'bar'});
    });

    it('should support callbacks', async (t) => {
      const queue = t.context.makeQueue();

      const job = await queue.createJob({foo: 'bar'}).save();

      const jobPromise = helpers.deferred();
      queue.getJob(job.id, jobPromise.defer());
      const gotJob = await jobPromise;

      t.is(gotJob.id, job.id);
    });
  });

  it.describe('removeJob', (it) => {
    it('should not cause an error if immediately removed', async (t) => {
      const queue = t.context.makeQueue();

      queue.process(async (job) => {
        if (job.id === 'deadjob') {
          t.fail('should not be able to process the job');
        }
      });

      const waitJob = queue._waitForJob, wait = helpers.deferred();
      let waitDone = wait.defer();
      queue._waitForJob = function (...args) {
        if (waitDone) {
          waitDone();
          waitDone = null;
        }
        return waitJob.apply(this, args);
      };

      await wait;

      const job = queue.createJob({foo: 'bar'}).setId('deadjob');
      await Promise.all([
        job.save(),
        queue.removeJob(job.id),
        queue.createJob({foo: 'bar'}).setId('goodjob').save(),
      ]);

      const goodJob = await helpers.waitOn(queue, 'succeeded');
      t.is(goodJob.id, 'goodjob');

      t.context.handleErrors(t);
    });

    it('should support callbacks', async (t) => {
      t.plan(0);

      const queue = t.context.makeQueue();

      const job = await queue.createJob({foo: 'bar'}).save();

      const removePromise = helpers.deferred();
      queue.removeJob(job.id, removePromise.defer());
      await removePromise;
    });
  });

  it.describe('Processing jobs', (it) => {
    it('processes a job', async (t) => {
      const queue = t.context.makeQueue();

      queue.process(async (job) => {
        t.is(job.data.foo, 'bar');
        return 'baz';
      });

      const job = await queue.createJob({foo: 'bar'}).save();
      t.truthy(job.id);
      t.is(job.data.foo, 'bar');

      const success = sinon.spy();
      queue.once('succeeded', success);
      await helpers.waitOn(queue, 'succeeded');

      const [[succeededJob, data]] = success.args;
      t.truthy(succeededJob);
      t.is(data, 'baz');

      t.true(await succeededJob.isInSet('succeeded'));
    });

    it('should process a job with a non-numeric id', async (t) => {
      const queue = t.context.makeQueue({
        getEvents: false,
        sendEvents: false,
        storeJobs: false,
      });

      queue.process(async (job) => {
        t.is(job.id, 'amazingjob');
        t.is(job.data.foo, 'baz');
      });

      const success = helpers.waitOn(queue, 'succeeded', true);

      await queue.createJob({foo: 'baz'}).setId('amazingjob').save();
      await success;

      const job = await queue.getJob('amazingjob');

      t.truthy(job);
      t.is(job.id, 'amazingjob');
      t.deepEqual(job.data, {foo: 'baz'});
      t.true(await job.isInSet('succeeded'));
    });

    it('processes a job with removeOnSuccess', async (t) => {
      const queue = t.context.makeQueue({
        removeOnSuccess: true
      });

      await queue.ready();

      const {hget} = promisify.methods(queue.client, ['hget']);

      queue.process(async (job) => {
        t.is(job.data.foo, 'bar');
      });

      const job = await queue.createJob({foo: 'bar'}).save();
      t.truthy(job.id);
      t.is(job.data.foo, 'bar');

      const succeededJob = await helpers.waitOn(queue, 'succeeded', true);
      t.is(succeededJob.id, job.id);

      const jobData = await hget(queue.toKey('jobs'), job.id);
      t.is(jobData, null);

      t.false(await job.isInSet('success'));
    });

    it('processes a job with removeOnFailure', async (t) => {
      const queue = t.context.makeQueue({
        removeOnFailure: true
      });

      await queue.ready();

      const {hget} = promisify.methods(queue.client, ['hget']);

      queue.process(async (job) => {
        t.is(job.data.foo, 'bar');
        throw new Error('failed :D');
      });

      const job = await queue.createJob({foo: 'bar'}).save();
      t.truthy(job.id);
      t.is(job.data.foo, 'bar');

      const succeededJob = await helpers.waitOn(queue, 'failed', true);
      t.is(succeededJob.id, job.id);

      const jobData = await hget(queue.toKey('jobs'), job.id);
      t.is(jobData, null);

      t.false(await job.isInSet('failed'));
    });

    it('processes a job that fails', async (t) => {
      const queue = t.context.makeQueue();

      queue.process(async (job) => {
        t.is(job.data.foo, 'bar');
        throw new Error('failed!');
      });

      const fail = sinon.spy();
      queue.once('failed', fail);
      const failed = helpers.waitOn(queue, 'failed');

      const job = await queue.createJob({foo: 'bar'}).save();
      t.truthy(job.id);
      t.is(job.data.foo, 'bar');

      await failed;
      const [[failedJob, err]] = fail.args;

      t.truthy(failedJob);
      t.is(failedJob.data.foo, 'bar');
      t.is(err.message, 'failed!');
      t.true(await failedJob.isInSet('failed'));
    });

    it('processes a job that throws an exception', async (t) => {
      const queue = t.context.makeQueue();

      queue.process(() => {
        throw new Error('exception!');
      });

      const fail = sinon.spy();
      queue.once('failed', fail);
      const failed = helpers.waitOn(queue, 'failed');

      const job = await queue.createJob({foo: 'bar'}).save();
      t.truthy(job.id);
      t.is(job.data.foo, 'bar');

      await failed;
      const [[failedJob, err]] = fail.args;

      t.truthy(failedJob);
      t.is(failedJob.data.foo, 'bar');
      t.is(err.message, 'exception!');
    });

    it('should capture error data', async (t) => {
      const queue = t.context.makeQueue();

      let stack;
      queue.process((job) => {
        if (job.data.error === 'Error') {
          const err = new Error('has stack');
          stack = err.stack;
          throw err;
        }
        throw job.data.error;
      });

      const errors = [
        'Error',
        {message: 'has message'},
        'is string',
        true,
      ];

      const jobs = errors.map((error) => queue.createJob({error}));
      const afterFailed = jobs.map((job) => helpers.waitOn(job, 'failed'));

      await Promise.all(jobs.map((job) => job.save()));
      await Promise.all(afterFailed);

      // Force getJobs to fetch fresh copies of the jobs.
      queue.jobs = new Map();

      const failed = await queue.getJobs('failed');
      const failedErrors = new Set(failed.map((job) => {
        t.is(job.options.stacktraces.length, 1);
        return job.options.stacktraces[0];
      }));

      t.deepEqual(failedErrors, new Set([stack, 'has message', 'is string', true]));
    });

    it('processes and retries a job that fails', async (t) => {
      const queue = t.context.makeQueue();

      let callCount = 0;
      queue.process(async (job) => {
        callCount++;
        t.is(job.data.foo, 'bar');
        if (callCount <= 1) {
          throw new Error('failed!');
        }
      });

      queue.on('failed', (job, err) => {
        t.truthy(job);
        t.is(job.data.foo, 'bar');
        t.is(err.message, 'failed!');
        job.retry();
      });

      const succeeded = helpers.waitOn(queue, 'succeeded');

      const job = await queue.createJob({foo: 'bar'}).save();
      t.truthy(job.id);
      t.is(job.data.foo, 'bar');

      await succeeded;
      t.is(callCount, 2);
    });

    it('processes a job that times out', async (t) => {
      const queue = t.context.makeQueue();

      queue.process((job) => {
        t.is(job.data.foo, 'bar');
        return helpers.delay(20);
      });

      const fail = sinon.spy();
      queue.once('failed', fail);
      const failed = helpers.waitOn(queue, 'failed');

      const job = await queue.createJob({foo: 'bar'}).timeout(10).save();
      t.truthy(job.id);
      t.is(job.data.foo, 'bar');
      t.is(job.options.timeout, 10);

      await failed;
      const [[failedJob, err]] = fail.args;

      t.truthy(failedJob);
      t.is(job.id, '1');
      t.is(failedJob.data.foo, 'bar');
      t.is(err.message, `Job ${job.id} timed out (10 ms)`);
    });

    it('processes a job that auto-retries', async (t) => {
      const queue = t.context.makeQueue();
      const retries = 1;
      const failMsg = 'failing to auto-retry...';

      const end = helpers.deferred(), finish = end.defer();

      let failCount = 0;

      queue.process(async (job) => {
        t.is(job.data.foo, 'bar');
        if (job.options.retries) {
          throw new Error(failMsg);
        }
        t.is(failCount, retries);
        finish();
      });

      queue.on('failed', (job, err) => {
        ++failCount;
        t.truthy(job);
        t.is(job.data.foo, 'bar');
        t.is(err.message, failMsg);
      });

      const job = await queue.createJob({foo: 'bar'}).retries(retries).save();
      t.truthy(job.id);
      t.is(job.data.foo, 'bar');
      t.is(job.options.retries, retries);

      return end;
    });

    it('should fail a job that has a retry but is intentionally stopped', async (t) => {
      const queue = t.context.makeQueue();

      let called = false;
      queue.process(async (job) => {
        if (called) {
          return t.fail('the job should not double-process');
        }
        called = true;
        job.retries(0);
        throw new Error('fatal error');
      });

      const job = await queue.createJob({}).retries(5).save();

      await helpers.waitOn(job, 'failed', true);

      t.true(called);
    });

    it('processes a job that times out and auto-retries', async (t) => {
      const queue = t.context.makeQueue();
      const retries = 1;

      const end = helpers.deferred(), finish = end.defer();

      let failCount = 0;

      queue.process(async (job) => {
        t.is(job.data.foo, 'bar');
        if (job.options.retries) {
          return helpers.defer(20);
        }
        t.is(failCount, retries);
        finish();
      });

      queue.on('failed', (job) => {
        failCount += 1;
        t.truthy(job);
        t.is(job.data.foo, 'bar');
      });

      const job = await queue.createJob({foo: 'bar'}).timeout(10).retries(retries).save();
      t.truthy(job.id);
      t.is(job.data.foo, 'bar');
      t.is(job.options.retries, retries);

      return end;
    });

    it('refuses to process when isWorker is false', (t) => {
      const queue = t.context.makeQueue({
        isWorker: false
      });

      t.throws(() => {
        queue.process();
      }, 'Cannot call Queue#process on a non-worker');

      t.context.handleErrors(t);
    });

    it('refuses to be called twice', (t) => {
      const queue = t.context.makeQueue();

      queue.process(() => {});

      t.throws(() => {
        queue.process();
      }, 'Cannot call Queue#process twice');

      t.context.handleErrors(t);
    });

    it('refuses to be called after close', (t) => {
      const queue = t.context.makeQueue();

      queue.close();

      t.throws(() => {
        queue.process(() => {});
      }, /closed/);

      t.context.handleErrors(t);
    });
  });

  it.describe('Processing many jobs', (it) => {
    it('processes many jobs in a row with one processor', async (t) => {
      const queue = t.context.makeQueue();
      const numJobs = 20;

      const end = helpers.deferred(), finish = end.defer();

      let counter = 0;

      queue.process(async (job) => {
        t.is(job.data.count, counter);
        counter++;
        if (counter === numJobs) {
          finish();
        }
      });

      const jobs = [];
      for (let i = 0; i < numJobs; i++) {
        jobs.push(queue.createJob({count: i}));
      }

      // Save all the jobs.
      await Promise.all(jobs.map((job) => job.save()));

      return end;
    });

    it('processes many jobs with one concurrent processor', async (t) => {
      const queue = t.context.makeQueue();
      const concurrency = 5;
      const numJobs = 20;

      const end = helpers.deferred(), finish = end.defer();

      let counter = 0;

      queue.process(concurrency, async (job) => {
        t.true(queue.running <= concurrency);
        await helpers.delay(10);
        t.is(job.data.count, counter);
        counter++;
        if (counter === numJobs) {
          finish();
        }
      });

      for (let i = 0; i < numJobs; i++) {
        await queue.createJob({count: i}).save();
      }

      return end;
    });

    it('processes many randomly offset jobs with one concurrent processor', async (t) => {
      const queue = t.context.makeQueue();
      const concurrency = 5;
      const numJobs = 20;

      const end = helpers.deferred(), finish = end.defer();

      let counter = 0;

      queue.process(concurrency, async () => {
        t.true(queue.running <= concurrency);
        await helpers.delay(10);
        counter++;
        if (counter === numJobs) {
          finish();
        }
      });

      for (let i = 0; i < numJobs; i++) {
        setTimeout(() => {
          queue.createJob({count: i}).save().catch(finish);
        }, Math.random() * 50);
      }

      return end;
    });

    it('processes many jobs with multiple processors', async (t) => {
      const queue = t.context.makeQueue();
      const processors = [
        t.context.makeQueue(),
        t.context.makeQueue(),
        t.context.makeQueue(),
      ];
      const numJobs = 20;
      const processed = new Set();

      const end = helpers.deferred(), finish = end.defer();

      let counter = 0;

      const handleJob = async () => {};

      const success = (job) => {
        if (processed.has(job.data.count)) {
          t.fail('job already processed');
        }
        processed.add(job.data.count);
        counter++;

        // Don't verify that we've finished until we've processed enough jobs.
        if (counter < numJobs) return;
        t.is(counter, numJobs);

        // Make sure every job has actually been processed.
        for (let i = 0; i < numJobs; i++) {
          t.true(processed.has(i));
        }
        finish(null, Promise.all(processors.map((queue) => queue.close())));
      };

      for (let queue of processors) {
        queue.process(handleJob).on('succeeded', success);
      }

      for (let i = 0; i < numJobs; i++) {
        queue.createJob({count: i}).save();
      }

      return end.then(() => t.context.handleErrors(t));
    });
  });

  it.describe('Backoff', (it) => {
    it('should fail for invalid backoff strategies and delays', (t) => {
      const queue = t.context.makeQueue({
        isWorker: false,
        getEvents: false
      });

      const job = queue.createJob({});
      t.throws(() => job.backoff('wow', 100), 'unknown strategy');
      t.throws(() => job.backoff('fixed', -100), /positive integer/i);
      t.throws(() => job.backoff('fixed', 44.5), /positive integer/i);
    });

    it('should handle fixed backoff', async (t) => {
      const queue = t.context.makeQueue({
        activateDelayedJobs: true
      });

      const calls = [];

      queue.process(async (job) => {
        t.deepEqual(job.options.backoff, {
          strategy: 'fixed',
          delay: 100
        });
        t.deepEqual(job.data, {is: 'fixed'});
        calls.push(Date.now());
        if (calls.length === 1) {
          throw new Error('forced retry');
        }
        t.is(calls.length, 2);
      });

      const succeed = helpers.waitOn(queue, 'succeeded', true);

      await queue.createJob({is: 'fixed'})
        .retries(2)
        .backoff('fixed', 100)
        .save();

      await succeed;

      t.is(calls.length, 2);

      // Ensure there was a delay.
      t.true(calls[1] - calls[0] >= 100);
    });

    it('should handle exponential backoff', async (t) => {
      const queue = t.context.makeQueue({
        activateDelayedJobs: true
      });

      let calls = [];

      queue.process(async (job) => {
        t.deepEqual(job.options.backoff, {
          strategy: 'exponential',
          delay: 30 * Math.pow(2, calls.length)
        });
        t.deepEqual(job.data, {is: 'exponential'});
        calls.push(Date.now());
        if (calls.length < 3) {
          throw new Error('forced retry');
        }
      });

      const succeed = helpers.waitOn(queue, 'succeeded', true);

      await queue.createJob({is: 'exponential'})
        .retries(3)
        .backoff('exponential', 30)
        .save();

      await succeed;

      t.is(calls.length, 3);

      // Ensure there was a delay.
      t.true(calls[1] - calls[0] >= 30);
      t.true(calls[2] - calls[1] >= 60);
    });
  });

  it.describe('Resets', (it) => {
    it('should reset and process stalled jobs when starting a queue', async (t) => {
      t.plan(0);

      const queue = t.context.makeQueue({
        stallInterval: 1
      });

      const jobs = [
        queue.createJob({foo: 'bar1'}),
        queue.createJob({foo: 'bar2'}),
        queue.createJob({foo: 'bar3'}),
      ];

      // Save the three jobs.
      await Promise.all(jobs.map((job) => job.save()));

      // Artificially move to active.
      await queue._getNextJob();

      // Mark the jobs as stalling, so that Queue#process immediately detects them as stalled.
      await helpers.delay(1); // Just in case - somehow - we end up going too fast.
      await queue.checkStalledJobs();
      await helpers.delay(1); // Just in case - somehow - we end up going too fast.

      const {done, next} = reef(jobs.length);
      queue.process(async () => {
        next();
      });

      return done;
    });

    it('resets and processes jobs from multiple stalled queues', async (t) => {
      const queues = [];
      for (let i = 0; i < 5; i++) {
        queues.push(t.context.makeQueue());
      }

      await Promise.all(queues.map(async (stallQueue) => {
        await stallQueue.ready();

        await Promise.all([
          // Do nada.
          stallQueue._getNextJob(),
          stallQueue.createJob({foo: 'bar'}).save(),
        ]);

        await stallQueue.close();
      }));

      const queue = t.context.makeQueue({
        stallInterval: 1
      });

      await queue.checkStalledJobs();
      await helpers.delay(1); // Just in case - somehow - we end up going too fast.

      const {done, next} = reef(queues.length);
      queue.process(async (job) => {
        t.is(job.data.foo, 'bar');
        next();
      });

      return done;
    });

    it('resets and processes stalled jobs from concurrent processor', async (t) => {
      const deadQueue = t.context.makeQueue({
        stallInterval: 1
      });
      const concurrency = 5;
      const numJobs = 10;

      // Disable stall prevention for the dead queue.
      sinon.stub(deadQueue, '_preventStall').callsFake(async () => {});

      const jobs = [];
      for (let i = 0; i < numJobs; i++) {
        jobs.push(deadQueue.createJob({count: i}));
      }

      // Save all the jobs.
      await Promise.all(jobs.map((job) => job.save()));

      const {done: resume, next: spooled} = reef();
      deadQueue.process(concurrency, () => {
        // Wait for it to get all spooled up...
        if (deadQueue.running === concurrency) {
          spooled();
        }
      });

      await resume;
      await t.throws(deadQueue.close(1), 'Operation timed out.');

      const queue = t.context.makeQueue({
        stallInterval: 1
      });

      await helpers.delay(1); // Just in case - somehow - we end up going too fast.
      await queue.checkStalledJobs();
      await helpers.delay(2); // Yes this has actually been too fast - we need to outrun redis' key.

      const {done, next} = reef(numJobs);
      queue.process(async () => {
        next() || t.fail('processed too many jobs');
      });

      return done;
    });

    it('should reset with an interval', async (t) => {
      // Open two queues:
      // - a queue that stalls all jobs
      // - a queue that processes all jobs
      // Produce two jobs such that the "bad" queue receives a job.
      // Safely finish the job in the "good" queue.
      // Close the "bad queue".
      // Run checkStalledJobs with an interval.
      // Once the queue emits a "stalled" event, create a new "bad" queue.
      // Publish another two jobs as above.
      // Once the "bad" queue has received a job, close it.
      // Ensure the jobs both process, and that the "good" queue emits a stalled event.

      const goodQueue = t.context.makeQueue({
        stallInterval: 50
      });

      const failStalled = () => t.fail('no job should stall yet');
      goodQueue.on('stalled', failStalled);

      const goodJobs = spitter();
      goodQueue.process((job) => goodJobs.pushSuspend(job));

      let deadQueue = t.context.makeQueue({
        stallInterval: 50
      });

      let deadJobs = spitter();
      deadQueue.process((job) => deadJobs.pushSuspend(job));

      // Save the two jobs.
      const firstJobs = await Promise.all([
        deadQueue.createJob({foo: 'bar1'}).save(),
        deadQueue.createJob({foo: 'bar2'}).save(),
      ]);

      await deadJobs.shift();

      const [, finishFirstGood] = await goodJobs.shift();

      // Finish the job in the good queue.
      finishFirstGood(null);

      // Force the dead queue to close with a timeout.
      await t.throws(deadQueue.close(1), 'Operation timed out.');

      const stalls = spitter();
      goodQueue.removeListener('stalled', failStalled);
      goodQueue.on('stalled', stalls.push);

      goodQueue.checkStalledJobs(120);

      // We now have a stalled job, and the good queue has already completed its initial stalled
      // jobs check.
      const firstStalledJobId = await stalls.shift();
      t.true(firstJobs.some((job) => job.id === firstStalledJobId));

      // Process the stalled job.
      (await goodJobs.shift())[1](null);

      deadQueue = t.context.makeQueue({
        stallInterval: 50
      });

      deadJobs = spitter();
      deadQueue.process((job) => deadJobs.pushSuspend(job));

      const secondJobs = await Promise.all([
        deadQueue.createJob({foo: 'bar1'}).save(),
        deadQueue.createJob({foo: 'bar2'}).save(),
      ]);

      const secondJobIds = new Set(secondJobs.map((job) => job.id));

      const [deadJob,] = await deadJobs.shift();
      await t.throws(deadQueue.close(1), 'Operation timed out.');

      const secondGoodBatch = new Set();

      const [secondGoodJob, secondGoodJobFinish] = await goodJobs.shift();
      secondGoodBatch.add(secondGoodJob.id);
      secondGoodJobFinish(null);

      const secondStalledJobId = await stalls.shift();
      t.is(secondStalledJobId, deadJob.id);
      t.not(secondStalledJobId, secondGoodJob.id);
      t.true(secondJobIds.has(secondStalledJobId));

      const [retriedJob, retriedJobFinish] = await goodJobs.shift();
      secondGoodBatch.add(retriedJob.id);
      retriedJobFinish(null);

      t.deepEqual(secondGoodBatch, secondJobIds);

      t.is(stalls.count(), 0);
      t.is(goodJobs.count(), 0);

      t.context.handleErrors(t);
    });
  });

  it.describe('Startup', (it) => {
    it('processes pre-existing jobs when starting a queue', async (t) => {
      const deadQueue = t.context.makeQueue();

      const jobs = [
        deadQueue.createJob({foo: 'bar1'}),
        deadQueue.createJob({foo: 'bar2'}),
        deadQueue.createJob({foo: 'bar3'}),
      ];

      // Save all the jobs.
      await Promise.all(jobs.map((job) => job.save()));
      await deadQueue.close();

      const queue = t.context.makeQueue();
      let jobCount = 0;

      const {done, next} = reef();
      queue.process(async (job) => {
        t.is(job.data.foo, 'bar' + ++jobCount);
        if (jobCount < 3) return;
        t.is(jobCount, 3);
        next();
      });

      await done;

      t.context.handleErrors(t);
    });

    it('does not process an in-progress job when a new queue starts', async (t) => {
      const queue = t.context.makeQueue();

      await queue.createJob({foo: 'bar'}).save();

      const jobDone = helpers.deferred(), finishJob = jobDone.defer();
      queue.process((job) => {
        t.is(job.data.foo, 'bar');
        return jobDone;
      });

      const queue2 = t.context.makeQueue();
      queue2.process(() => {
        t.fail('queue2 should not process a job');
      });

      await helpers.delay(20);
      finishJob();

      await helpers.waitOn(queue, 'succeeded', true);
    });
  });

  it.describe('Pubsub events', (it) => {
    it('emits a job succeeded event', async (t) => {
      const queue = t.context.makeQueue();
      const worker = t.context.makeQueue();

      const job = queue.createJob({foo: 'bar'});
      const record = Promise.all([
        recordUntil(job, ['succeeded'], 'succeeded'),
        recordUntil(queue, ['job succeeded'], 'job succeeded'),
      ]);

      worker.process(async (job) => job.data.foo + job.data.foo);
      await job.save();

      // Wait for the event to show up in both, but only bind the value from the event on the job
      // object.
      const [jobEvents, queueEvents] = await record;

      t.deepEqual(jobEvents, [
        ['succeeded', 'barbar'],
      ]);

      t.deepEqual(queueEvents, [
        ['job succeeded', job.id, 'barbar'],
      ]);
    });

    it('emits a job succeeded event with no result', async (t) => {
      const queue = t.context.makeQueue();
      const worker = t.context.makeQueue();

      const job = queue.createJob({foo: 'bar'});
      const record = Promise.all([
        recordUntil(job, ['succeeded'], 'succeeded'),
        recordUntil(queue, ['job succeeded'], 'job succeeded'),
      ]);

      worker.process(async () => {});
      await job.save();

      // Wait for the event to show up in both, but only bind the value from the event on the job
      // object.
      const [jobEvents, queueEvents] = await record;

      t.deepEqual(jobEvents, [
        ['succeeded', undefined],
      ]);

      t.deepEqual(queueEvents, [
        ['job succeeded', job.id, undefined],
      ]);
    });

    it('emits a job failed event', async (t) => {
      const queue = t.context.makeQueue();
      const worker = t.context.makeQueue();

      const job = queue.createJob({foo: 'bar'});
      const record = Promise.all([
        recordUntil(job, ['failed'], 'failed'),
        recordUntil(queue, ['job failed'], 'job failed'),
      ]);

      worker.process(async () => {
        throw new Error('fail!');
      });
      await job.save();

      // Wait for the event to show up in both, but only bind the value from the event on the job
      // object.
      const [jobEvents, queueEvents] = await record;

      const jobErr = jobEvents[0][1];
      t.is(jobErr.message, 'fail!');
      t.deepEqual(jobEvents, [
        ['failed', jobErr],
      ]);

      const queueErr = queueEvents[0][2];
      t.is(queueErr.message, 'fail!');
      t.deepEqual(queueEvents, [
        ['job failed', job.id, queueErr],
      ]);
    });

    it('emits a job progress event', async (t) => {
      const queue = t.context.makeQueue();
      const worker = t.context.makeQueue();

      const job = queue.createJob({foo: 'bar'});
      const record = Promise.all([
        recordUntil(job, ['progress', 'succeeded'], 'succeeded'),
        recordUntil(queue, ['job progress', 'job succeeded'], 'job succeeded'),
      ]);

      worker.process((job) => {
        job.reportProgress(20);
        return helpers.delay(20);
      });
      await job.save();

      // Wait for the event to show up in both, but only bind the value from the event on the job
      // object.
      const [jobEvents, queueEvents] = await record;

      t.deepEqual(jobEvents, [
        ['progress', 20],
        ['succeeded', undefined],
      ]);

      t.deepEqual(queueEvents, [
        ['job progress', job.id, 20],
        ['job succeeded', job.id, undefined],
      ]);
    });

    it('emits a job retrying event', async (t) => {
      const queue = t.context.makeQueue();
      const worker = t.context.makeQueue();

      const job = queue.createJob({foo: 'bar'}).retries(1);
      const record = Promise.all([
        recordUntil(job, ['retrying', 'succeeded'], 'succeeded'),
        recordUntil(queue, ['job retrying', 'job succeeded'], 'job succeeded'),
      ]);

      let retried = false;
      worker.process(async () => {
        if (!retried) {
          retried = true;
          throw new Error('failing job to trigger retry');
        }
      });
      await job.save();

      // Wait for the event to show up in both, but only bind the value from the event on the job
      // object.
      const [jobEvents, queueEvents] = await record;

      t.is(job.options.retries, 0);

      const jobErr = jobEvents[0][1];
      t.is(jobErr.message, 'failing job to trigger retry');
      t.deepEqual(jobEvents, [
        ['retrying', jobErr],
        ['succeeded', undefined],
      ]);

      const queueErr = queueEvents[0][2];
      t.is(queueErr.message, 'failing job to trigger retry');
      t.deepEqual(queueEvents, [
        ['job retrying', job.id, queueErr],
        ['job succeeded', job.id, undefined],
      ]);
    });

    it('are not received when getEvents is false', async (t) => {
      const queue = t.context.makeQueue({
        getEvents: false
      });
      const worker = t.context.makeQueue();

      t.is(queue.eclient, null);

      await queue.createJob({foo: 'bar'})
        // Holy race condition, batman!
        .on('succeeded', () => t.fail('should not trigger a succeeded event'))
        .save();

      worker.process(async (job) => {
        return job.data.foo;
      });

      await helpers.waitOn(worker, 'succeeded');
      await helpers.delay(20);
    });

    it('are not sent when sendEvents is false', async (t) => {
      t.plan(0);

      const queue = t.context.makeQueue();
      const worker = t.context.makeQueue({
        sendEvents: false
      });

      await queue.createJob({foo: 'bar'})
        .on('succeeded', () => t.fail('should not trigger a succeeded event'))
        .save();

      worker.process(async (job) => {
        return job.data.foo;
      });

      await helpers.waitOn(worker, 'succeeded');
      await helpers.delay(20);
    });

    it('properly emits events with multiple jobs', async (t) => {
      const queue = t.context.makeQueue();
      const worker = t.context.makeQueue();

      const job1 = queue.createJob({foo: 'bar'});
      const job2 = queue.createJob({foo: 'baz'});
      const record = Promise.all([
        recordUntil(job1, ['succeeded'], 'succeeded'),
        recordUntil(job2, ['succeeded'], 'succeeded'),
        recordUntil(queue, ['job succeeded'], 'derped'),
      ]);

      worker.process(async (job) => job.data.foo + job.data.foo);
      await Promise.all([job1.save(), job2.save()]);

      queue.once('job succeeded', () => queue.once('job succeeded', () => queue.emit('derped')));

      // Wait for the event to show up in both, but only bind the value from the event on the job
      // object.
      const [job1Events, job2Events, queueEvents] = await record;

      t.deepEqual(job1Events, [
        ['succeeded', 'barbar'],
      ]);

      t.deepEqual(job2Events, [
        ['succeeded', 'bazbaz'],
      ]);

      // Ordering here is guaranteed assuming no network errors.
      t.deepEqual(queueEvents, [
        ['job succeeded', job1.id, 'barbar'],
        ['job succeeded', job2.id, 'bazbaz'],
      ]);
    });
  });

  it.describe('Destroy', (it) => {
    it('should remove all associated redis keys', async (t) => {
      const queue = t.context.makeQueue();

      queue.process(async (job) => {
        t.is(job.data.foo, 'bar');
      });

      const job = await queue.createJob({foo: 'bar'}).save();
      t.truthy(job.id);
      t.is(job.data.foo, 'bar');

      const successJob = await helpers.waitOn(queue, 'succeeded');
      t.truthy(successJob);

      await queue.createJob({foo: 'bip'})
        .delayUntil(Date.now() + 10 * 24 * 60 * 60 * 1000)
        .save();

      await queue.destroy();

      const {keys: getKeys} = promisify.methods(queue.client, ['keys']);
      const keys = await getKeys(queue.toKey('*'));
      t.deepEqual(keys, []);
    });

    it('should fail after closed', async (t) => {
      const queue = t.context.makeQueue();

      await queue.close();

      await t.throws(queue.destroy(), 'closed');
    });

    it('should support callbacks', async (t) => {
      const queue = t.context.makeQueue();

      await queue.createJob({zoo: 't'}).save();

      const destroyPromise = helpers.deferred();
      queue.destroy(destroyPromise.defer());
      await destroyPromise;

      const {keys: getKeys} = promisify.methods(queue.client, ['keys']);
      const keys = await getKeys(queue.toKey('*'));
      t.deepEqual(keys, []);
    });
  });
});
