-- Players are RO-style 2D sprites again (shared/look.ts): gender + job outfit + dyed hair (hair_color index).
-- Characters made while 3D heads existed only stored `head`; 006 mapped female looks to the Rogue heads, so reverse it.
-- head/clothes/hair_style stay for history but are unused.
UPDATE characters SET gender = 'F' WHERE head IN ('Rogue', 'Rogue_Hooded');
