

## (Problem Statement): These are my thoughts from first reading the prompts 

There are two instances of failures:
1) Double booking: two occupants on the same berth on overlapping days 
2) Fit violation: a vessel longer than the berth is assgined to 

Given that this is over 23 year of data, I want to make the insertion fast. So some kind of data structure that is good for intervals. 

I should also think whether this is read heavy or write heavy and optimize my database on that. 

Other than any other kind of invariants that exist for example that I'm not accounting for. 

Data ingestion:

I'm probably go to build the front-end out using a nice SKIPPER UI framework.
What the user needs to do is simply just upload the sample files (the one provided or a mix).

Then the app will be able to clean the data or excel file into a sort of like ingestible format for it to run checks and a) highlight out the conflicts 
b) what type the conflicts are and the details
c) run a solver that shows how these can be fixed 

I think that's mainly what I can do for now. 
 
Okay the thing is right:
The whole point of this app is for future data not for the past 23 years...


Yeah so there's two ways I can append things and check for the errors/collisions:

1. So first is the ability to upload an entire xslx file

2. Then second is the ability to just insert one at a time 

For example maybe I can desing an API endpoint where the user adds one at a time ...

That would be good enough?

Maybe 

Like u can just selct things? 
Or add items

Then in terms of database like we got to like think about how to make the lookup fast and not N + 1 time complexity

im thinking of using interval schedulling so that is like a sPNegment tree or some kind of more optimized data strucutre

need to think about how to like optimize it so that the lookup is faster 


_____


Also since the sample data is back into the 1990s, should i maybe start off with a date that is like on the start date or something. 

Or u can configure what date u currently are on? 

I think i should write out a workflow manual md file for that
