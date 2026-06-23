Major:
- [ ] thread level configuration
- [ ] file and attachement sharing
- [ ] need to have the good meta prompt, or inject role-based instruction to provide context on what they are doing
- [ ] current setup path is a bit redudant and confusing
- [ ] change framing to person -> bots => channels (projects) => threas (tasks)
- [ ] 

Done Need test:
- [ ] other coding agents 
- [ ] other social media platform
- [ ] watch


the conflict is not on the artifact but the action(artifact)
our crdt policy is role-based, human > bot (bot sort it out but need to warn human)

Minor:
- [ ] the setup should not ask about the bot name and bot description? unless the bot is being introuduced with different roles?
- [ ] whats the context agent reading?
- [ ] easier way for user to terminate action 
- [-] maybe make sync a special primitives so no need to relay through discord channel -> this is done but kind of weird because now we need Neon to host the postgres sql



====
set of actions: read, write file, rape(Ryan).... (default primitives)
...infer new actions from the default primitive:
-> read_then_write
```
when read (A):
    then write file (B) -> return C;
```

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



