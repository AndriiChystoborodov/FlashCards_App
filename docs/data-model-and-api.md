Data Model

Courses (
teacher_id,
material_url,
title,
status,
sent_at,
starts_at,
ends_at
)
Users (
fullName,
email,
slack_id,
role: Teacher|Student
)
Enrollments (
course_id,
user_id,
enrolled_at,
assessment_done_at
)
Flashcards (
id,
course_id,
question,
options,
answer,
is_assesment,
material_url,
position
)
Card_States (
user_id,
flashcard_id,
scheduled_at,
sent_at,
correct_streak,
introduced_at,
// FSRS
fsrs_stability,
fsrs_difficulty,
fsrs_state:New/Learning/Review/Relearning,
last_reviewed_at,
)
Reviews (
student_id,
flashcard_id,
chosen_option,
is_correct,
rating:Hard/Midium/Easy,
reviewed_at
)

APIs Rest API

Courses CRUD

POST /courses
{
"title": "Compliance",
"material_url": string,
"ends_at": "data"
"scheduled_start_at": "data"
}

status "draft" by default

GET /courses?id=

{
"courses": [
{
"id": "1234",
"title": "Compliance",
"material_url": "string",
"status": "draft" | "active" | "finished",
"scheduled_start_at": data,
"starts_at": "data",
"ends_at": "data",
"card_count": number,
"assessment_card_count": number,
"student_count": number
}
]
}

PATCH /courses/:id Stop course
{
"title": string,
"material_url": string
"scheduled_start_at": data,
"ends_at": data
}

DELETE /courses/:id

Flashcards

POST /courses/:id/flashcards
{
"flashcards": [
{
"question": "strimg",
"options": ["1", "2", "3"],
"correct_option": 1,
"material_url": "string,
"is_assessment": boolean
},
]
}

DELETE /courses/flashcards/id

Assessment

PUT /courses/:id/assesment
{
"flashcards_ids": ["1", "2", "3"]
}

Class

Post /courses/:id/students
{
"students": [
{ "email": "example@example.com", "name": "example" }
{ "email": "example@example.com", "name": "example" }
]
}

GET /courses/:id/students
{
"students": [
{
"student_id": "id",
"email": "example",
"name": "example",
"enrolled_at": "data",
"assessment_done": boolean
}
]
}

Progress

GET /courses/:id/progress
{
"course_id": "id",
"class_progress": number,
"students": [
{ "student_id": "id", "name": "example", "progress": num,
"known": num, "total": num, "assessment_done": true }
]
}

GET /courses/:id/students/:id/progress
{
"student_id": "id",
"name": "example",
"progress": num,
"known": num,
"total": num,
"assessment_done": boolean,
"cards": [
{
"flashcard_id": "id",
"question": "string",
"known": boolean,
"correct_streak": num,
"due_at": "data",
"last_answer_correct": boolean
},
]
}

Students

GET /users/:id/courses

{
"courses": [
{
"course_id": "id",
"title": "string",
"status": "string",
"progress": num,
"assessment_done": boolean
}
]
}

POST /user/flashcards/:id/reviews
{
"chosen_option": num,
"rating": "easy | medium | hard"
}
{
"is_correct": boolean,
"correct_option": num,
"rating": "string",
"material_url": "string,
"progress": num
}
