import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';

const crons = cronJobs();

crons.interval('clear stale loading messages', { minutes: 60 }, internal.messages.cleanupLoadingMessages);

// Firefly III connector: daily balance and repo-rate refresh for users with automatic sync on (06:30 IST)
crons.daily('firefly sync', { hourUTC: 1, minuteUTC: 0 }, internal.firefly.scheduledSync);

export default crons;
