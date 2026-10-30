// Common Indian given names and surnames (lower-case). Raises confidence for compromise.js person
// matches; it is not a whitelist. Extend freely; keep entries generic, never real individuals.
const GIVEN = `aarav aditya akash amit anand anil anita anjali ankit anup arjun arun asha ashok bhavna deepa deepak devi
dinesh divya ganesh gaurav geeta gopal hari harish indira jaya jyoti kavita kiran krishna kumar lakshmi lalita madhu
mahesh manish manoj meena mohan mukesh nandini neha nikhil nisha pankaj pooja prakash pranav priya rahul raj rajesh
rakesh ramesh rani ravi rekha rohit sachin sandeep sanjay santosh sarita seema shalini shanti shilpa shiva shyam sneha
sonia sudha sunil sunita suresh swati usha vijay vikram vinod vishal yash abdul ahmed ali aisha fatima imran mohammed
salman sana zainab anu arya aswathy biju jinu lijo manju midhun nithin reshma rinu sajan shaji sreeja vineeth`;
const SURNAMES = `sharma verma gupta singh kumar patel shah mehta joshi iyer iyengar nair menon pillai kurup warrier namboothiri
reddy rao naidu chowdary das dutta ghosh bose banerjee chatterjee mukherjee sen roy mishra pandey tiwari dubey yadav
jain agarwal khan sheikh qureshi siddiqui thomas mathew joseph george varghese kurian abraham cherian chacko fernandes
dsouza pinto gomes kaur gill sandhu bhat kulkarni deshpande patil pawar more jadhav gowda hegde shetty`;

export const INDIAN_NAME_TOKENS: ReadonlySet<string> = new Set(`${GIVEN} ${SURNAMES}`.split(/\s+/).filter(Boolean));
