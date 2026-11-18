/**
 * Name lists for the conservative name redactor. Broad on purpose: over-redaction is
 * acceptable, under-redaction is not. Matching is case-sensitive on capitalized words.
 */

export const FIRST_NAMES: ReadonlySet<string> = new Set(
  `Aaliyah Aaron Abby Abdul Abigail Ada Adam Adrian Adriana Agnes Ahmed Aidan Aiden Aisha Alan Albert
  Alberto Alejandra Alejandro Alex Alexa Alexander Alexandra Alexis Alfred Ali Alice Alicia Alina Alisha
  Allison Alma Alvin Amanda Amara Amber Amelia Amina Amir Amit Amy Ana Anan Andre Andrea Andres Andrew
  Andy Angela Angelica Angelo Anil Anita Ann Anna Anne Annie Anthony Antonio Anya April Arjun Arthur
  Arturo Asha Ashley Ashok Aubrey Audrey Austin Ava Avery Ayesha Barbara Beatriz Becky Ben Benjamin
  Bernard Beth Bethany Betty Beverly Bianca Billy Blake Bobby Bonnie Brad Bradley Brandon Brenda Brendan
  Brett Brian Brianna Bridget Brittany Brooke Bruce Bryan Caleb Calvin Cameron Camila Carl Carla Carlos
  Carmen Carol Caroline Carolyn Carrie Casey Cassandra Catherine Cathy Cecilia Chad Charles Charlie
  Charlotte Chen Cheryl Chloe Chris Christian Christina Christine Christopher Cindy Claire Clara Claudia
  Clayton Cody Colin Connor Courtney Craig Cristina Crystal Curtis Cynthia Daisy Dale Dana Daniel
  Daniela Danielle Danny Darius Darnell Darren David Dawn Deborah Debra Denise Dennis Derek Desmond Diana
  Diane Diego Dimitri Dominic Donald Donna Doris Dorothy Douglas Duane Dustin Dylan Eddie Edgar Eduardo
  Edward Edwin Eileen Elaine Eleanor Elena Eli Elias Elijah Elisa Elizabeth Ella Ellen Ellie Elsa Emily
  Emma Emmanuel Enrique Eric Erica Erik Erin Ernest Esther Ethan Eugene Eva Evan Evelyn Fatima Felicia
  Felix Fernando Fiona Florence Frances Francesca Francis Francisco Gabriel Gabriela Gabrielle Gary
  Gavin George Georgia Gerald Gina Giovanni Gloria Gordon Graham Greg Gregory Gustavo Hailey Haley Hamza
  Hana Hannah Harold Harper Harris Harry Hassan Hayden Heather Hector Helen Henry Hiroshi Holly Howard
  Hugo Hunter Ian Ibrahim Ines Irene Isaac Isabel Isabella Isaiah Ivan Jack Jackie Jackson Jacob Jacqueline
  Jade Jaime Jake Jamal James Jamie Jan Jane Janet Janice Jared Jasmine Jason Javier Jay Jayden Jean
  Jeff Jeffrey Jenna Jennifer Jenny Jeremy Jerome Jerry Jesse Jessica Jesus Jill Jim Jimmy Joan Joanna
  Joe Joel John Johnny Jon Jonathan Jordan Jorge Jose Joseph Josh Joshua Joyce Juan Judith Judy Julia
  Julian Julie Julio Justin Kai Kaitlyn Kamal Karen Karina Karl Kate Katherine Kathleen Kathryn Kathy
  Katie Kayla Keisha Keith Kelly Kelvin Ken Kenji Kenneth Kevin Khalid Kim Kimberly Kofi Kristen Kristin
  Kwame Kyle Lakshmi Lana Lara Larry Laura Lauren Lawrence Leah Lee Leila Lena Leo Leon Leonardo Leslie
  Liam Lily Linda Lindsay Lisa Logan Lorenzo Lori Louis Louise Lucas Lucia Lucy Luis Luke Luna Lydia
  Lynn Madison Mai Malik Mandy Manuel Marcia Marco Marcus Margaret Maria Mariah Marie Marilyn Mario
  Marisol Marissa Marjorie Marta Martha Martin Marvin Mary Mason Mateo Matthew Maureen Maya Megan Mei
  Melanie Melissa Mia Michael Michelle Miguel Mika Mike Mila Miles Min Mohamed Mohammed Monica Morgan
  Muhammad Nadia Nancy Naomi Natalia Natalie Nathan Neil Nicholas Nicole Nikhil Nina Noah Noel Nora
  Norma Olga Oliver Olivia Omar Oscar Owen Pablo Paige Pamela Patricia Patrick Paul Paula Pedro Peggy
  Penny Peter Philip Phillip Phoebe Pooja Priya Rachel Rafael Rahul Raj Rajesh Ramon Randy Raquel Ravi
  Rebecca Regina Renee Rhonda Ricardo Richard Rick Ricky Riley Rita Rob Robert Roberto Robin Rodrigo
  Roger Roland Ronald Rosa Ruby Russell Ruth Ryan Sabrina Sadie Salma Sam Samantha Samir Samuel Sandra
  Sanjay Sara Sarah Scott Sean Sebastian Sergio Seth Shannon Sharon Shawn Sheila Shirley Sierra Simon
  Sofia Sonia Sophia Sophie Stacy Stanley Stella Stephanie Stephen Steve Steven Sunil Susan Suzanne
  Sydney Sylvia Tamara Tammy Tanya Tara Tariq Taylor Teresa Terrence Terry Thomas Tiffany Timothy Tina
  Todd Tom Tommy Tony Tracy Travis Trevor Tyler Valentina Valerie Vanessa Veronica Victor Victoria
  Viktor Vincent Violet Virginia Vivian Walter Wanda Warren Wayne Wei Wendy Wesley William Willie Xavier
  Yasmin Yolanda Yuki Yusuf Zachary Zara Zoe`
    .split(/\s+/)
    .filter(Boolean),
);

/** First names that are also common English words; skipped when they plainly start a sentence. */
export const AMBIGUOUS_FIRST_NAMES: ReadonlySet<string> = new Set(
  `Art Autumn Bill Bob Chase Don Faith Frank Grace Guy Hope Iris Ivy Joy June Mark Max May Pat Ray
  Rich Rose Sky Summer Sunny Will`
    .split(/\s+/)
    .filter(Boolean),
);

export const SURNAMES: ReadonlySet<string> = new Set(
  `Adams Adeyemi Ahmed Ali Allen Alvarez Anderson Bailey Baker Banerjee Barnes Bell Bennett Brooks Brown
  Butler Campbell Carter Castillo Chan Chang Chavez Chen Clark Clarke Collins Cook Cooper Costa Cox Cruz
  Das Davis Diaz Dubois Edwards Evans Farouk Fernandez Fisher Flores Foster Garcia Gomez Gonzalez Gray
  Green Gupta Gutierrez Haddad Hall Harris Hernandez Hill Howard Hughes Hussain Ivanova Jackson James
  Jenkins Johnson Jones Kelly Khan Kim King Kowalski Kumar Lee Lewis Lindqvist Lopez Martin Martinez
  Mensah Miller Mitchell Moore Morales Moreno Morgan Morris Murphy Murray Nair Nasser Nelson Nguyen Novak
  Okafor Ortiz Parker Patel Perez Peterson Petrova Phillips Price Ramirez Reed Reyes Richardson Rivera
  Roberts Robinson Rodriguez Rogers Rossi Ruiz Sanchez Sanders Schmidt Scott Shah Silva Singh Smith
  Stewart Sullivan Tanaka Taylor Thomas Thompson Torres Turner Walker Walsh Wang Ward Washington Watson
  White Williams Wilson Wood Wright Wu Yamamoto Yang Young Zhang`
    .split(/\s+/)
    .filter(Boolean),
);
