import { Event } from "./events-database.js";

export class EventBuffer {
  constructor(flushIntervalMs) {
    this.queue = [];
    this.flushInterval = setInterval(() => this.flush(), flushIntervalMs);
  }

  enqueue(event) {
    this.queue.push(event);
  }

  async flush() {
    if (this.queue.length === 0) return;
    let queue = this.queue;
    this.queue = [];
    try {
      await Event.bulkCreate(queue);
    } catch (error) {
      console.error("Failed to flush events:", error);
    }
  }
}
