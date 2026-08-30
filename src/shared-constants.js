/*
Event types to be stored in the Events Database for offline analysis.

Events are:

CODE_RUN: happens when an instructor or student runs the code. The payload
should include the complete code that was run (i.e., the contents of the editor)
and a timestamp.

STUDENT_START_EXERCISE: happens when a student first makes an edit when answering
either a poll (multiple-choice or free response) or coding exercise. May be
duplicated if the student reloads the page and makes an edit (i.e., this is the
first edit to an exercise for a given page load). Payload is a timestamp and the
exercise ID.

STUDENT_SUBMIT_EXERCISE: happens when a student submits a exercise. Even though
exercise responses are already stored elsewhere, this event gives extra information
if students submit multiple responses. The payload is a timestamp, the exercise ID,
and their answer to the exercise (either multiple-choice, free response, or code).

STUDENT_END_EXERCISE: an event to record the student's answer to an exercise as
the instructor ends it (i.e., the event fires in response to the student's client
receiving the message that the exercise has ended). The payload contains a timestamp,
the exercise ID, and the current answer to the exercise (even if it's unsubmitted).
This is primarily used to see if a student entered an answer but didn't submit it.

INSTRUCTOR_CREATE_VARIANT: an event for when an instructor creates a new variant.
The payload should have the timestamp, the variant ID, the VersionBlock ID, and an
optional flag that says whether the variant was created from the plus button or from
importing a student solution via the sidebar.

INSTRUCTOR_DESTROY_VARIANT: an event for when an instructor deletes a variant.
The payload should contain the timestamp, the variant ID, the VersionBlock ID, the
variant's name, and the content of the variant (i.e., the code).

INSTRUCTOR_START_POLL_CREATION: happens when an instructor opens the "Create poll"
popover (right after right-clicking selected code and choosing "Ask question"), i.e.
before they've written anything. The payload is just a timestamp. Since only one poll
draft can be open at a time, this can be paired with the following
INSTRUCTOR_START_EXERCISE event for the resulting poll to measure how long drafting took.

INSTRUCTOR_START_EXERCISE: happens when an instructor creates any exercise (a poll,
multiple-choice poll, or coding exercise) and it goes live for students. This fires once
the exercise is actually created (server-assigned ID and all), since that's the earliest
point an exercise ID exists. The payload is a timestamp and the exercise ID.
*/
export const EVENT_TYPES = Object.freeze({
  CODE_RUN: 0,
  STUDENT_START_EXERCISE: 1,
  STUDENT_SUBMIT_EXERCISE: 2,
  STUDENT_END_EXERCISE: 3,
  INSTRUCTOR_CREATE_VARIANT: 4,
  INSTRUCTOR_DESTROY_VARIANT: 5,
  INSTRUCTOR_START_POLL_CREATION: 6,
  INSTRUCTOR_START_EXERCISE: 7,
});

export const ANONYMOUS_STUDENT_MODE = true;

export const SOCKET_MESSAGE_TYPE = Object.freeze({
  JOIN_SESSION: "JOIN_SESSION",
  INSTRUCTOR_EDIT: "INSTRUCTOR_EDIT",
  INSTRUCTOR_CURSOR: "INSTRUCTOR_CURSOR",
  INSTRUCTOR_CODE_RUN: "INSTRUCTOR_CODE_RUN",
  INSTRUCTOR_END_SESSION: "INSTRUCTOR_END_SESSION",
  STUDENT_CODE_EDIT: "STUDENT_CODE_EDIT",
  STUDENT_NOTES_EDIT: "STUDENT_NOTES_EDIT",
  INSTRUCTOR_OUT_OF_SYNC: "INSTRUCTOR_OUT_OF_SYNC",
  STUDENT_OUT_OF_SYNC: "STUDENT_OUT_OF_SYNC",
  EXERCISE_CREATED: "EXERCISE_CREATED",
  EXERCISE_FINISHED: "EXERCISE_FINISHED",
  STUDENT_SUBMITTED: "STUDENT_SUBMITTED",
  VERSION_BLOCK_CREATED: "VERSION_BLOCK_CREATED",
  VARIANT_ADDED: "VARIANT_ADDED",
  VARIANT_RENAMED: "VARIANT_RENAMED",
  VARIANT_DELETED: "VARIANT_DELETED",
  VARIANT_EDIT: "VARIANT_EDIT",
  VARIANT_CURSOR: "VARIANT_CURSOR",
  VERSION_BLOCK_DELETED: "VERSION_BLOCK_DELETED",
});
