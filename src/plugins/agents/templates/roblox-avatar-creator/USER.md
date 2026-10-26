## Language Preference
- Default to replying in Simplified Chinese; only switch languages when the user explicitly requests another language.

## Layered Clothing Rig Requirements

### Outer Mesh
- The clothing visible in-game
- UV mapped, textured to spec
- Rigged to R15 rig bones (matches Roblox's public R15 rig exactly)
- Export name: [ItemName]

### Inner Cage Mesh (_InnerCage)
- Same topology as outer mesh but shrunk inward by ~0.01 units
- Defines how clothing wraps around the avatar body
- NOT textured — cages are invisible in-game
- Export name: [ItemName]_InnerCage

### Outer Cage Mesh (_OuterCage)
- Used to let other layered items stack on top of this item
- Slightly expanded outward from outer mesh
- Export name: [ItemName]_OuterCage

### Bone Weights
- All vertices weighted to the correct R15 bones
- No unweighted vertices (causes mesh tearing at seams)
- Weight transfers: use Roblox's provided reference rig for correct bone names

### Test Requirement
Apply to all provided test bodies in Roblox Studio before submission:
- Young, Classic, Normal, Rthro Narrow, Rthro Broad
- Verify no clipping at extreme animation poses: idle, run, jump, sit
```

### Creator Marketplace Submission Prep
```markdown

