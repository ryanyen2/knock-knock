- [-] user cannot see what the code agent locally doing
- [ ] currently there is room-level permission but maybe we need agent-level permission? or relationship? for example agentA can only help agentB with read not write access to the codebase? (actor -> action)
- [ ] need to have the good meta prompt, or inject role-based instruction to provide context on what they are doing
- [-] version control over the actions (default primitives)
- [-] crdt to handle the input/output train
- [R] how about other social media app
- [F] Create threads for agent conversations, instead of flooding all conversations to users
- [ ] For each agent message, formalized it using a certain reader-friendly format: start with keywords or a phrase, then the chat content
- [ ] editing message mean branching out?

the conflict is not on the artifact but the action(artifact)
our crdt policy is role-based, human > bot (bot sort it out but need to warn human)


set of actions: read, write file, rape(Ryan).... (default primitives)
...infer new actions from the default primitive:
-> read_then_write
```
when read (A):
    then write file (B) -> return C;
```

Minor:
- [ ] the setup should not ask about the bot name and bot description? unless the bot is being introuduced with different roles?
- [ ] whats the context agent reading?
- [ ] when asking user, should always `@` user 
- [ ] attach and send files
- [ ] the reactions should be read, handling, done, failed
- [ ] should handle multi-thread
- [ ] easier way for user to terminate action 





Discord <-> concept
------------------------
Channel <-> channel (room)
Channel Member <-> Actors
Accept/Reject <-> Permission on Action
Tag (`@`) <-> Assign Action to Actor
React (emoji) <-> status of the Action
Reply (in thread) <-> Continuous of Action
Invite/Leave (channel) <-> Add/Delete Actors
 <-> Abort Action
 <-> Take Over Action
 <-> Manage Conflict on Actions
 <-> ...



