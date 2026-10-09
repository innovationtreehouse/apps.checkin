CheckMeIn-next Design Specification

Use Cases

UC1: Member checks in/out of the facility, times for each event are recorded.

UC2: A user generates reports of building attendance given a start and end time.
	Extension A: The report is generated for a specific program
	Extension B: The report distinguishes between participants and volunteers
	Extension C: The report is for a single user

UC3: User can manage their own account
	Extension A: User can create an account
	Extension B: Primary account holder for a family can edit accounts in the family
	Extension C: Primary account holder can convert a family member to be a primary account holder for a new family after the member turns 18

UC3: Superusers can assign roles, where the role holders have access only to data pertinent for their scope of access (e.g a program leader can see their program data)
	Extension A: One of these roles is ‘current member’, which automatically adds the member and all family members to the appropriate google groups
	Extension B: One of these roles is ‘prior member’, which automatically removes the member and all family members from prior groups, but retains newsletter access

UC4: Recording of background checks and payments with appropriate audit trails

UC5: Recording of membership agreement signing

UC6: Recording of tool certifications

UC7: Team and program management tools

Repositories

The original CheckMeIn was created by members of The Forge Initiative: https://github.com/alan412/CheckMeIn

The Innovation Treehouse repository is here: https://github.com/innovationtreehouse/checkmein-next

Infrastructure and Hosting
We currently use an AWS Postgres-compliant database instance for the wiki at programs.innovationtreehouse.org, so we should design around that for this application. The SQL interactions should be done through an ORM like SQLAlchemy.

The application should be containerized so it can run in EKS or other container services that reduce our maintenance overhead.

The checkin/checkout interface runs on a raspberry pi.

Narrative of Features and User Interactions
Checking in and Checking Out
A user scans the QR code on the back of their nametag. The scanner is a TTY device that produces the decoded string on that TTY. If the user is not checked into the building, the system records the check in. If the user is checked in, then the system records a check out. In either case, the screen indicates the result to the user.
Viewing Current Attendance
On the same screen used for reporting the above status for checking in or checking out, the current attendance is displayed. This lists everyone who is in the building at that time. Current attendance is also viewable remotely by certain users (like admins and keyholders).
Tracking Keyholder and Two Deep Compliance
On the current attendance screen, the list of keyholders currently in the building is displayed. When the keyholder list reduces to 1, a warning is displayed indicating that only one keyholder is in the building. When the keyholder list reduces to 0, the keyholder is prompted to close the facility. Further information can be found in Treehouse Event, Location and Keyholder Policy
Opening and Closing the Facility
If no keyholder is in attendance, the facility is closed. Only a keyholder opens the facility; anyone else who badges in while it is closed is still checked in, and their visit is marked "no keyholder". When the last keyholder checks out, the facility closes. When the facility closes, the users currently in attendance should be 0. If any users are still in attendance (indicating a missed checkout), that user is automatically checked out and the user is notified.
User Accounts
All users have accounts. These accounts are google accounts (managed via OAuth 2.0) and are used to both authenticate to the CheckMeIn-next system and to receive notifications. When logging in, the identity must either be mapped to an existing participant who has the exact same email address, or a brand new participant record must be created. Inheriting access from unrelated accounts or database rows is strictly prohibited. User accounts contain data about the user and are organized by family. Each family has a primary account and attached participant accounts. The system also understands minors vs adults to inform the above two deep compliance.
User Roles
The system shall support multiple user roles, some of which restrict access to information. These restrictions must be enforced on the backend (not the UI, though the UI should not advertise functionality to a user who cannot use it).

System administrator: some users will have the ability to assume the role of sysadmin for a limited time. While acting in this role they are able to change any aspect of the system (that does not require a code change). Examples include changing someone's email or phone number, signing up for a class, changing a users role (except you cannot add or remove the role of admin, that will be hard coded into the system). There will be an extra explicit audit log of any actions taken by users while in the admin role. It should be very obvious to a user when they have this role active, so they don't accidentally take any actions that a normal user could not.

Board Member
Has read access to everything on the system. They are accountable for this entire operation. They will likely all be sysadmin, but again should not accidentally be able to change any system property on accident. Has read access especially to the audit log of every action taken by any member.

Board members may always check in or check out members from the treehouse.

Core Volunteer
If appointed, core Volunteers can check students in and out of the treehouse during or near the time of their program, or edit the attendance for students, members or volunteers to that program.

Program Leaders
Should be able to set, create, edit instances of their program (which includes start time, end time, date, recurrence, expected member list, expected volunteer list). They are expected to validate the attendance at the conclusion of each program instance, but may delegate or appoint core Volunteers who can perform this validation on a program by program basis.

Key holders
Are expected to be the first in the building, and the last to leave.
They are allowed to check anyone in or out while they are at the building.
When the last key holder checks out, they must confirm that everyone has left the building, and all members are then forcibly checked out.

Student 
A subset of participant who is unable to change their own phone number, email, address. And who must have an associated parent/guardian. By default any participant under 18 is a student

Parent/Guardian
Have the option to be notified every time their student checks in or out.
They can change their students email, phone number, and indicate intent to attend or miss programs their student is signed up for.

Participant
While at the building, 
Can check themselves in
Can check themselves out
Are allowed to view event schedules for programs, and indicate intent to attend or intent to miss any future programs they are signed up for

Member
Some participants are members, who will be allowed to see and sign up for member-only communication/programs. They may have different pricing for a program. 

Tool Certification 
Members may be certified on a given tool, allowing them certain permissions on it. Non member participants may not be certified on any tool.

Tool Certifier
See more info in the next section.

Tool Certification Display
The system tracks user tool certifications and displays them in the shop for all members in attendance. Changes to user tool certifications require a special role: Tool Certifier. The Tool Certifier role should be designed on a per-tool basis. More information can be found in Treehouse Shop Safety Rules and Certification Process
Analytics Interface
An interface generally available on the internet provides users access to the system remotely. This remote access does not allow checking in or checking out but does allow for time adjustments should the user have not checked out. For some roles, this also allows report generation for meeting attendance and hours tracking.
Meetings and Events
The system shall be designed with awareness of meeting and event schedules to allow filtering of hours that are for volunteer purposes vs hours that are participation.
This system will be the source of truth for what programs are active at the treehouse, who leads them, who is signed up for them, when their events are, etc. the program lead should create all of that.
Membership Management
The system understands the management onboarding process through user account fields. These include contact information, dates of birth, membership expiration date, background check date, and background check approvers. Information relating to background check approvers shall be viewable only by background check approvers and administrators. Part of member management is support of a renewal flow.

Generally, member onboarding has the following steps:
User creates an account
User adds family members to that account
User is directed to Shopify to purchase membership
Shopify notifies CheckMeIn-next that payment completed.
Integration with Other Treehouse Systems
CheckMeIn-next shall integrate with Shopify for recording member payments and with Zoho Sign or eSignatures.io for document signing. 

This is all later stages of development, more clarity will be required before this happens.

Notifications 
Users should be able to login to the backend system via oath and manage their notifications. They should be able to choose between email, text, and slack (or multiple) for a variety of events:
They entered
They left
They were checked out by someone else
They registered for a program 
Their program is staring in 2 hrs
New program offerings available for signup

All of the above for any of their dependants
Event Audit 
Changes to user accounts, tool certifications, and payment shall have an Audit trail via a suitable change recording mechanism in the database.

Client architecture 
The client that is running on a raspberry pi or similar should have a few elements:
Most importantly be a loop waiting for scanning events from a connected USB handsfree scanner.
If a QR code is scanned then the event is sent to the backend, the response is shown on a screen. The QR code should be a simple ID, which is matched to the user account by the backend.

Secondarily, the client can be used as a way for a sufficiently permissioned user to click “edit” then scan their badge, then get to do special things, like check a participant in or out.

By default the screen should show a list of participants currently in the building, with indicators for key holders.

If the client goes offline it should be ready to store events that it sees and replay them to the server when it's online. It should prominently display an orange banner if it's offline.

For now, the client should be assumed to have a long lived service account key/token. 

Data Model
The following tables will represent the data model 

Participants
ID int64 (primary key)
Google_ID string // more proper than email for authN purposes
Email string
DOB date
HomeAddress string? (Default to household)
LastWaiverSign datetime
WaiverSignedBy int64
LastBackgroundCheck datetime
Household int64 (foreign key)
Sysadmin bool
BoardMember bool
Keyholder bool
ShopSteward bool

ToolStatus
User int64 (pk)
Tool int64 (pk)
Level {Basic,
          DoF,
          Certified,
          MayCertifyOthers}
Tools
ID int (pk)
Name string
SafetyGuide string
Households
ID int (pk)
Address string
HouseholdLeads // aka parent/guardian
Household int (pk, fk)
Participant int (pk, fk)
Memberships
ID int (pk)
Since datetime
Type {household, volunteer, corporate} // force that only one type may be selected, and based on that enforce that only one of the following foreign keys is provided.
Household int?
Volunteer int?
Corporate int?
Active bool
LatestShopifyReciept string?
LatestDocusign string

Corporations 
ID int (pk)
PrimaryEmail string 
Address string 

CorporationLeads
Corporation int (pk, fk)
Participant int (pk, fk)

CorporationMembers
Corporation int (pk, fk)
Participant int (pk, fk)
Programs
ID int (pk)
Name string 
LeadMentor int
Begin datetime
End datetime

ProgramVolunteers
Program int (pk, fk)
Volunteer int (pk, fk) // this is a FK to participants.ID
IsCore bool

ProgramParticipants
Program int (pk, fk)
Participant int (pk, fk)

Events
ID int
Program int?
Name string
Start datetime
End datetime 
Description string

RSVP
Event int (pk, fk)
Participant int (pk, fk)
Status {ATTENDING, NOT_ATTENDING, NO_RESPONSE, MAYBE}
RawBadgeEvents // this should never be changeable even by sysadmin
ID int (pk)
Participant int
Time datetime
Location string

Visits // this should be editable by appropriate parties if anyone forgets / messes up badging
ID int (pk)
Participant int
Arrived timestamp
Departed timestamp
AssociatedEvent int?


AuditLog
ID int
Time timestamp
ActorID int
Action {CREATE, EDIT, DELETE, BECOME_ADMIN}
Table string
AffectedEntity int
SecondaryAffectedEntity int // in cases of 2 primary keys
OldData JSONB 
NewData JSONB

Deployments
This system should be deployable both locally for testing purposes and production-ready to aws. There should be documentation for both. There should be as much shared infra as possible to minimize behavior differences between testing and running.


