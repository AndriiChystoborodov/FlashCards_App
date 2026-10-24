# Requirements

## Functional

- The teacher has an interface to orchestrate a learning course.
- The teacher creates a class with students for the course.
- Students are notified when a course starts or stops.
- The teacher can create flashcards.
- The teacher marks flashcards for the initial assessment.
- A flashcard has a question and multiple-choice answers, including "Don't know".
- A flashcard links to a course.
- A flashcard links to material.
- A course links to material.
- The student selects an effort level: Easy, Medium, Hard.
- Based on the initial assessment and all previous answers, the student gets more flashcards during the course.
- The teacher sees the progress of each student and of the class as a percentage. 100% means the student knows the material.

### Out of scope

- Flashcards personalized by role, with roles defined by the teacher.
- Free-form answers.
- An LLM integration for generating flashcards.

## Non-functional

- AI first = API first.
- An MCP server to interact with the API.
- One tenant per company or university.
- Average load: 1,000 students in one class.
- Maximum number of flashcards per course: open question (500 assumed).
- Slack for messaging.

### Out of scope

- A teacher portal.
- An upper bound of 10 million students.

## Definitions

- Learned card: the student's last two answers to it (the same card, answered again on repetition) in a row were right and rated Medium or Easy, and the latest of them came at least 7 days after the previous review of that card. A card passed in the initial assessment (right + Easy) counts as learned immediately.
- Student progress: learned cards / all cards in the course. 100% means every card is learned, or the student passed the initial assessment threshold and is exempt.
- Class progress: the average of student progress over all enrolled students.
