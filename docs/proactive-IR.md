Generating Queries from User Contexts via In-Context Learning
for Proactive Retrieval
Anonymous Author(s)
ABSTRACT
Proactive information retrieval (PIR) systems aim to anticipate a
user’s evolving information needs based on their recent activities,
whilst Information Retrieval (IR) systems are reactive, responding
to explicit user queries. In this work, we address an intermediate step within PIR systems: automatically generating meaningful
follow-up queries directly from a user’s recently browsed documents. We introduce a novel query formulation method that uses
in-context learning (ICL), leveraging a collection of semantically related query pairs—queries whose top-retrieved documents partially
overlap—to model how one information need may transition into
another. Using these examples, our approach generates novel yet
topically coherent queries grounded in a user’s recent browsing.
We evaluate our method in a controlled simulated environment
using the standard TREC DL and TREC COVID benchmarks, which
simulate a realistic scenario in which a user’s recent browsing activity provides contextual clues but no explicit query. This also
allows a reproducible experimental setup with available manual
relevance assessments. Results show that our ICL-based approach
consistently outperforms zero-shot and standard query formulation baselines and remains robust across various ranking models,
including lexical, sparse, late-interaction, and re-ranking methods.
CCS CONCEPTS
• Information systems → Users and interactive retrieval.
KEYWORDS
Large Language Models, Proactive Search, Query formulation
ACM Reference Format:
Anonymous Author(s). 2026. Generating Queries from User Contexts via
In-Context Learning for Proactive Retrieval. In Proceedings of The 49th
International ACM SIGIR Conference on Research and Development in Information Retrieval (SIGIR ’26). ACM, New York, NY, USA, 12 pages. https:
//doi.org/XXXXXXX.XXXXXXX
1 INTRODUCTION
Existing IR systems typically operate reactively, requiring users to
issue and refine queries while navigating through ranked results
until their information needs are met [15, 26, 37, 47, 57]. However,
users engaged in activities carried out towards a particular task
may not recognise emergent information needs or be aware of
helpful relevant information [7]. This is amplified in the context
Permission to make digital or hard copies of all or part of this work for personal or
classroom use is granted without fee provided that copies are not made or distributed
for profit or commercial advantage and that copies bear this notice and the full citation
on the first page. Copyrights for components of this work owned by others than the
author(s) must be honored. Abstracting with credit is permitted. To copy otherwise, or
republish, to post on servers or to redistribute to lists, requires prior specific permission
and/or a fee. Request permissions from permissions@acm.org.
SIGIR ’26, Jul 20-24, 2026, Melbourne, Naarm, Australia
© 2018 Copyright held by the owner/author(s). Publication rights licensed to ACM.
ACM ISBN 978-x-xxxx-xxxx-x/YY/MM. . . $15.00
https://doi.org/XXXXXXX.XXXXXXX
Q1: What are some 
traditional Swahili dishes?
Q2: What ingredients are 
commonly used?
Q3: Are there any unique 
herbs in Swahili cuisine?
…
PIR-LLM Query 
Formulation
Time
Proactive IR
User: Activities (e.g. Browsing)
QF
Cooking Techniques
Swahili Cooking 
Techniques
Flight to Kenya
Swahili Recipes
…
Quick dinner recipes
My Kenyan friend 
invited me to dinner to 
experience Swahili 
dishes, so I’m curious 
about Swahili cuisine.
User’s 
Mental Map
Reactive IR
QF
QF
QF
Time
Figure 1: User information seeking (adapted from the TREC Sessions
track overview paper [15]) via traditional IR system (the user explicitly provides queries) versus Proactive IR system (system anticipates
queries from user activities).
of exploratory information needs, where users often lack a clear
understanding of what they are seeking [2, 15, 68], and effective
information seeking may require prior familiarity with the content [55]. Even when users are aware of their information needs,
they may differ in their ability to formulate effective queries [6, 33].
Experienced searchers typically construct queries that yield more
relevant results than less experienced users [85].
Prior research has attempted to address these challenges by
introducing extended forms of system interaction. These include
interactive search systems involving multi-stage query reformulation [26, 44, 52], results-driven query refinement [26, 44, 52],
system-generated suggestions to improve query effectiveness [1,
18, 32, 35, 57, 61], conversational search systems with clarifying
questions [2, 53], and semantic retrieval to improve the quality of
search results when queries and relevant documents do not have
explicit term overlap [46].
We present a new approach in the evolving area of Proactive
Information Retrieval (PIR), where the aim is to anticipate a user’s
information needs without a direct query formulation based information access request from the user [9, 71].
We focus on an environment where the system has access to the
user’s recent activity—specifically, the documents that they have
recently read—to formulate subsequent information needs. For example, consider the following example scenario in Figure 1 where a
user becomes curious to learn more about Swahili cuisine because
they have been invited to a friend’s home, who is from Kenya, to
experience traditional Swahili dishes. Figure 1 contrasts the usersystem interactions in a conventional reactive information-seeking
system with a proactive information seeking system. With a reactive IR system (a), the user has to submit queries such as “Swahili
dishes”, and as they engage with the search results, their information need may naturally evolve into more specific queries, such as:
1
SIGIR ’26, Jul 20-24, 2026, Melbourne, Naarm, Australia Anon.
“What are some traditional Swahili dishes?”. In contrast, a proactive
system (b) predicts this evolving information need based on the
user’s browsing activity.1 The system connects the user’s interest
in cooking with their upcoming trip, and presents Swahili recipes
to the user automatically. Existing search system approaches use
query suggestion, generating follow-up queries prior to presenting
results to the user’s initial input query. This approach of query
suggestion is not applicable in our context as it would be operating
reactively to the input query explicitly provided by the user.
In this paper, we first propose a simulated framework that simulates a user’s recent browsing activity using a number of documents
with varied relevance that are topically related to (but not relevant
to) a latent information need that is hidden from the system. Using data from established Cranfield-style evaluation campaigns, we
demonstrate that a variety of existing baselines (including RM3 [34],
Doc2Query [59], and zero-shot and few-shot LLM prompting) significantly fall short of the performance of an oracle system with
access to the underlying information need.
We also develop a novel approach to model the evolution of
information needs which are then executed on standard rankers. We
observe that our results hold across a variety of retrieval methods,
including lexical, late interaction, learned sparse, and re-ranking.
We also propose a new method that uses in-context learning (ICL)
over a database of queries with related-but-not-relevant documents.
Specifically, we select ICL samples from the MS MARCO training
set by selecting the top-retrieved documents exhibit intermediate
ranges of rank-biased overlap (RBO) values to the target documents.
These pairs aim to represent cases where one query may evolve
into the other, and thus serve as informative examples of how
information needs may change over time. We find that this approach
substantially improves above the baseline and narrows the gap
to the oracle system. For instance, when using a learned sparse
retriever, our method achieves an nDCG@10 of 0.2058, up from
0.0888 for the strongest baseline and nearly halving the gap to the
oracle performance of 0.4916.
Our Contributions. In summary, the paper makes the following
contributions:
• We propose the simulated framework to carry out experiments
as per a standard IR framework – benchmark queries, collection
and manual relevance judgements.
• We propose an ICL-based approach for generating queries from
user contexts to model the information need evolution.
• That it works consistently for a number of tankers of different
characteristics.
2 RELATED WORK
A central contribution of this work is a proactive approach to predicting and formulating a user’s evolving information without relying
on user-formulated queries. This approach uses in-context learning
(ICL) grounded in semantically related query-pair examples. Existing IR paradigms and research fall short of this goal for several key
reasons, which we outline below.
1Our PIR formulation that focuses on documents that exist within the user’s environment allows the user’s context to come from a variety of sources, including web
navigation, chat messages, files stored on disks, and interactions with reactive search
systems, users, or chatbots.
Traditional IR. Traditional IR systems follow a reactive paradigm
in which users must recognise their information need, formulate
explicit queries, then navigate through retrieved, ranked documents
to find information that is relevant to their information need [10].
This approach assumes that users possess both the awareness of
identifying their information need and the skill to translate it into
effective queries [6, 33]. This assumption does not hold in practice,
particularly in scenarios where users may not have sufficient domain knowledge to formulate effective queries. Since traditional IR
systems are reactive, they cannot anticipate evolving user information needs or proactively suggest relevant information for the user,
which creates a gap between the information that could be useful
and the information users actually discover.
To overcome these limitations, recent work introduced extensions that are able to support users throughout the search process
in the form of system interaction [11, 16, 31, 49, 56, 62, 79, 81, 86].
Existing work has developed interactive search sessions that enable
query reformulation at multiple iterations of the search session,
allowing users to refine their queries based on the retrieved results
to better express their information needs [11, 22, 79]. This allows
the system to work proactively, rather than relying solely on explicit user queries. Other work has focused on aiming to improve
the user’s search experience through topic model visualisation [29],
which highlights the distribution of various topics within each of
the retrieved results.
Conversational Search Systems. Conversational search systems
extend this idea of proactivity by using natural language, dialoguebased interactions to ask the user clarifying questions to address ambiguous queries and guide users toward their information-seeking
goals [2, 11, 31, 49, 56, 62, 79, 81]. Recent work further explores
conversational proactive search. Several studies focus on retrieving additional context, such as supporting online discussions by
creating datasets from Reddit discussion threads as forms of conversation [66], or expanding this effort by curating a benchmark
dataset with relevance judgements specifically for proactive retrieval settings [69]. In both cases, user comments or passages
are treated as queries to be used on a chosen retriever. Additional
efforts examine query formulation frameworks using Query Performance Prediction alongside query formulation to address the
potential need for additional context [60], or reformulating a user
conversational context into queries [51].
Proactive search sessions. Proactive search in a search-session
setting also differs fundamentally from our approach. Traditional
search-session approaches rely on explicit, sequential user queries
as direct expressions of information need [43, 54, 84] and focus
primarily on query formulation within an active search session [72,
74]. These methods require explicit user queries, which are often
unavailable at the early stage of users’ information seeking.
Query suggestion research predicts a user’s next query based on
their search behaviour, which can be used to assist users in regard
to query formulation [12, 13, 67]. Approaches include graph learning to generate query suggestions through link predictions [61],
attention-based hierarchical neural query suggestion to model the
user’s “short-term” search context in order to effectively predict the
next user query [18], an attention-based recurrent neural network
for query reformulation predictions based on previous query reformulations performed by the user throughout the search session [35],
2
Generating Queries from User Contexts via In-Context Learning for Proactive Retrieval SIGIR ’26, Jul 20-24, 2026, Melbourne, Naarm, Australia
and a two-level hierarchical recurrent neural network that takes a
user query and a user’s past search activities from the same search
session and suggest the next query for the user given a predicted
document ranking result for the given query [1]. Large Language
Model (LLM)-based approaches extend this work, including multimodal query suggestion [80], where the user query images are used
as input and uses LLMs and multi-agent Reinforcement Learning
with human feedback to generate textual query suggestions.
LLMs in IR and PIR. LLMs have advanced multiple IR tasks,
including PIR [16, 36, 41, 81], query generation for conversational
search and contextualisation [60], and extracting information needs
from user context [81]. Additional work on query formulation
often focuses on extracting terms from individual documents using
encoder-decoder based neural approaches in order to generate
query terms [30] that make use of either user profiles [75], extracted
entities and noun phrases for query formulation from user selected
text [40], or different fields of a structured document in order to
formulate queries [23]. A related area explores extracting query
terms form large documents [17, 76].
Recommender Systems. Modern LLM-based recommender systems mainly prioritise personalisation and item ranking rather
than query formulation from an evolving information need from
a user’s browsing activity [42, 83, 87], often using multi-turn dialogue between the system and the user for preference elicitation and
providing relevant recommendations [38]. These systems target
recommendation tasks, not query formulation, and rely on ongoing
user interaction.
Differences with Existing Work. Regarding research in Conversational Search Systems, we focus on using a user’s general browsing
activity as the basis for proactive retrieval rather than conversational contexts. Rather than relying on explicit queries or multi-turn
dialogue, we use ICL with semantically related query-pair information to understand a user’s evolving information need.
Unlike Proactive search sessions, our system does not predict
user-entered queries at all. Instead, it directly formulates effective
queries from the user’s browsing context to capture the evolving
information need, without any prior query history.
Our work diverges from existing work of LLMs in IR and PIR
by generating queries from multiple related documents and by
leveraging related query-pair examples through ICL, illustrating
how one information need may evolve into another.
As for recommender systems, we perform proactive query formulation based solely on browsing activity, without dialogue or explicit
instructions, to retrieve information aligned with a user’s evolving
information need.
3 PROACTIVE IR FRAMEWORK
In this section, we formally describe the overall workflow of the
proactive IR framework, and also describe how we simulate a proactive search environment under a controlled setup for reproducible
experiments.
3.1 Proactive Search Environment
User Context. In contrast to a conventional search system, where
a user �� explicitly issues a query ��, a proactive information retrieval
(PIR) system takes as input a context��(��, ��) of a topic ��. This work is
motivated by the idea that a textual context reflecting the user’s recent
exposure to information on a general topic �� can sufficiently capture
their evolving information need. Importantly, the context ��(��, ��) –
which for notational convenience, we now denote as �� – serves as
an informational trace about a topic, rather than a direct expression
of an information need. As such, it cannot be directly used as a
query. To enable retrieval, we therefore require a query formulation
model �� that transforms the context �� into a set of �� potential
queries, i.e.,
�� : �� ↦→
Ø��
��=1
����
. (1)
Query Formulation. This task of formulating a query, as shown in
Equation 1, is equivalent to extracting the information needs from a
context. This is similar to query term discrimination to distinguish
important information from verbose queries [4], or using selective
content from whole documents to retrieve other similar documents
[76].
As a next step, we propose to apply a standard ranking model �� :
�� ↦→ {��1, . . . , ���� } on these estimated queries, thus retrieving the top-
�� potentially relevant documents for each candidate information
need. This is followed by a reciprocal rank fusion (RRF) based
combination of the search results [20]. RRF is a parameter free,
simple and empirically proven to be equivalent or better than other
parameterised approaches [20]. More formally, ���� (��), the final list
of �� documents proactively retrieved as a function of the input
context ��, is given by
���� (��) =
Ø
��∈�� (��)
RRF(���� (��ˆ)), (2)
where ���� (��ˆ) is the list of top-�� documents retrieved by the ranking
model �� for each query ��ˆ estimated from the user context �� by
applying the query formulation model ��, and RRF denotes the
reciprocal rank fusion method of combining multiple top-retrieved
lists into a single list [19]. From Equations 1 and 2, it can be seen that
a PIR model that outputs a ranked list of �� documents given a user
context �� is parameterised as a combination of a query formulator
model �� and a ranking model ��, i.e.,
��(��;��, ��) ↦→ ���� (��). (3)
PIR Evaluation. The effectiveness of a PIR model ��(��;��, ��) can
be assessed by comparing the documents in the retrieved list ���� (��)
with the set of documents that are actually related to the true
underlying information need.
In a real-world setting with actual users, this evaluation could be
performed using explicit feedback or by analysing implicit interaction signals such as clicks and dwell times. However, such strategies
raise privacy concerns, as they require logging user queries and
click data. Additionally, evaluations based on simulations can act
as the first step when developing a new method, such that the best,
or final, method is evaluated in user studies. Furthermore, user
studies are inherently non-reproducible and deviate from the standard practice of assessing IR systems using depth-pooled relevance
judgments, which have been shown to be challenging to obtain
for task-based user studies [25, 39]. To address these challenges, in
Section 3.2, we propose a simulated evaluation setup that enables
reproducible and controlled benchmarking of PIR systems.
3
SIGIR ’26, Jul 20-24, 2026, Melbourne, Naarm, Australia Anon.
3.2 Simulated User Contexts
We leverage the available graded relevance assessments of a standard IR benchmark, namely TREC DL’19 and ’20 [21] – the underlying target collection being the MS MARCO v1 passage collection [5]. Notationally speaking, for each query �� ∈ ��, let ��(��)
denote the set of relevant documents for �� (here, �� denotes a set
of benchmark queries). In particular for TREC DL datasets, the
set ��(��) constitutes of relevant documents of three grades, 1 (partially relevant), 2 (somewhat relevant), and 3 (highly relevant), i.e.,
��(��) = ��1 (��) ∪ ��2 (��) ∪ ��3 (��), where ����(��) = {�� : Rel(��, ��) = ��}.
The user context of Equation 1 is now simulated by a subset of
documents from the set ��1 (��), i.e., a subset of partially relevant
documents:
��(��) = {�� : Rel(��, ��) = 1}. (4)
These documents, which are partially relevant to ��, represent a
cognitive knowledge state of the user before obtaining the target information. In practice, this may be constituted by a communication
history or by the documents that the user has started exploring,
e.g., going back to the “Swahili dishes” from Figure 1, the context
can be the chat conversation of the user with her Kenyan friend,
or documents that are potentially relevant to a broad query like
“Swahili dishes” that she has submitted to a search system. However,
these documents are likely not to address the information needs of
the further more specific ways in which the initial query may have
evolved, e.g., those on the ingredients or the names of the dishes.
Our simulated setup considers the original TREC DL query �� as
one such concrete evolution of the information need (i.e., the target
query). Since a document �� in our simulated context is partially
relevant to a TREC DL query, it is likely to be relevant to some
other query ��
′ different from ��, i.e.,
∀�� ∈ ��(��), Rel(��, ��) = 1 =⇒ ∃��
′
: Rel(��
′
, ��) = 3, ��′ ≠ ��. (5)
In order to allow for generalisability to other scenarios, we also
leverage the available graded relevance assessments from TREC
COVID [78]. For TREC COVID, we use a similar setup with the only
difference being that the task is to find grade 2 relevant documents
given a context of grade 1 relevant documents.
Although neither the PIR system nor the simulated environment
knows this query ��
′ of Equation 5, we assume that �� – the query
with which we started the simulation of the context – is a valid
state of information need evolution from ��(��). Our simulated environment framework also assumes a single evolution path from a
partially relevant document to the initial query to the query itself,
which may penalise documents for not being relevant to a particular TREC DL or TREC COVID query, even though they might be
relevant to other ways the information need could evolve.
3.3 PIR Task and Evaluation
In the simulated environment, the input to a PIR model is a sample
of size �� from the set of documents ��(��) of Equation 4 that are
partially relevant to a query ��, i.e.,
�� ≡ ���� (��) ∼ ��(��), �� < |��(��)| (6)
where �� is a small number of documents sampled from the set of
documents judged to be partially relevant for query ��. A sampled
subset, mimicking users’ limited exploration via the Search Engine
Results Page (SERP), simulates only a small fraction of the knowledge state, reflecting another related but possibly broader topic. The
task of a PIR model (Equation 3) is then to retrieve documents of a
higher relevance grade (e.g. ��3 (��) for TREC DL and ��2 (��) for TREC
COVID) and are not known to the PIR model. The effectiveness of
the model is then measured by standard IR metrics, such as nDCG,
on ���� (��).
4 GENERATIVE QUERY FORMULATION
After describing our proposed generic architecture of a PIR model
and its evaluation with a simulated workflow in Section 3, we now
describe our proposed context-aware proactive query formulator
function ��, based on in-context learning, for a PIR model.
4.1 Generation with Localized Examples
Given an input text, associated with an appropriate prompt instruction, a pre-trained decoder of a large language model (LLM)
is capable of generating potentially relevant text as per any natural language processing (NLP) task requirement, such as question
answering (QA) [45, 77], summarisation [48], etc. In this study, we
aim to predict a set of possible ways in which information needs
may evolve from an immediate context, represents users’ search
situation, which in our evaluation setup, is a sample of a known
set of �� documents, ���� (��), partially relevant to a TREC DL query
�� (see Equation 6). More formally,
��ˆ = �� (���� (��); ��LLM), (7)
where ��ˆ denotes the generative output from the pre-trained decoder parameters ��LLM constituting a set of predicted queries from
a context. This aligns with ○1 as shown in Figure 2.
In-context learning (ICL) enhances the demonstration of certain
tasks by including a small number of illustrative examples [14, 63].
When used, it is equivalent to modifying Equation 7 with augmented context. In common NLP tasks, this additional context is a
topically related content, e.g., question-answer pairs for other questions similar to the one to be answered for a QA task, or examples
of document preference for a query similar to the target query for
a pairwise ranking task [73].
In our setting, the goal is to clarify the expected query formulation strategy with both positive (good) and negative (bad) examples
of query formulation. A good example refers to a likely evolution
of information need, inferred via a contextually appropriate query,
whereas a negative example either denotes a situation when the
reformulated query is almost similar to the initial information need,
or one with a substantial topic drift.
4.2 Example query-pairs
To identify such example pairs, we first generate a single zero-shot
query using Equation 7. We then map this generated query to the
closest matching query within the MS MARCO training set. We
carry out this step so that we can use an index to retrieve the
candidates and conduct a rescoring using RBOs for query semantic similarity and gives weight to more important commonalities
amongst the retrieved candidates. The use of MS MARCO training
queries is consistent across all datasets used in our experiments,
4
Generating Queries from User Contexts via In-Context Learning for Proactive Retrieval SIGIR ’26, Jul 20-24, 2026, Melbourne, Naarm, Australia
LLM
Zero-shot Query Formulation
Query 
Neighbour
Index Query similarity 
measured by RBO
Query-pair selection
Example 
QueryPairs
Localised 
K-shot 
Prompt “monotonic function 
properties”
Retrieval Final Query Formulation
Retrieved results In-Context
Learning
PIR-LLM Query Formulation (SIGIR 
Amendments) – Open the Box
User context Closest match 
MS MARCO train 
set query
“calculus in economics 
cost function”
“what are examples of 
monotonically increasing 
functions in calculus”
Labelling the examples with high/low RBO
(1) “calculus in economics cost function”→
“who is the father of calculus”
(2) “calculus in economics cost function”→
“volume of washer calculus”
(1) “calculus in economics cost function”→
“what is integral calculus”
(2) “calculus in economics cost function”→
“age of calculus”
I’ve never heard of 
monotonic being used for 
two (input) variables …
…the order in the 
definition of monotonicity 
is replaced by the strict 
order, then one obtains a 
stronger requirement
…
ICL
Example 
Context
1 2
4 3
, ,
,
( ) ( )
( ) ,
( )
Generation with Localised 
Examples
Figure 2: Schematic diagram of the proposed proactive system workflow. Given user-context documents: ○1 generates an initial query, ○2
matches the query to the closest MS MARCO training query to obtain query pairs, which then ○3 classifies the pairs into either good or bad,
and then ○4 uses these labelled pairs, the user context and the initial query to produce the final query for proactive retrieval.
Prompt for Zero-shot Query Generation (Obtain ��ˆ of Equation 7)
Imagine you are a search engine user who is looking for information on a topic and have
come across a set of documents, which you have read. When given the documents, think about
what could be the possible ways in which your information need can evolve so that you can
further explore along the broad topic.
For the given document context, formulate a single search query that must be at most 10 terms,
and with no special characters, in lowercase, that points to a related but, importantly, different
information need (e.g., more specific, or more generic). Your response must only contain the
generated short search query inside <query> and </query>, with no extra details.
Context: ���� (��)
Figure 3: Prompt structure used to generate a 0-shot query from
a given context, i.e., to obtain ��ˆ in Equation 7. Key phrases of the
prompt text are underlined.
Prompt for ICL-based Query Generation (Equation 9)
Given an input query and the context, your task is to reformulate the query. For
query formulation, you must consider the provided examples of what can be considered
good reformulations (topically related yet distinct) vs. those that are bad ones. Your response
must only contain the generated short search query inside <query> and </query>, with no extra
details. The generated query must be 10 words or fewer, lowercase, with no special characters.
Context: {���� (��)}
Input query: {��ˆ}
Example query-pairs:
Good reformulations: {∀ (��, �� ˆ
′
) ∈ ��
1
��
(��ˆ′
)}
Bad reformulations: {∀ (��, �� ˆ
′
) ∈ ��
0
��
(��ˆ′
)}
Figure 4: Prompt for the ICL-based query generation, where informed choices are made by an LLM in the presence of task-specific
definitions of good and bad query reformulations. Key phrases from
the prompt text are underlined.
and because of this consistency, experiments conducted through
TREC COVID are an out-of-domain evaluation.
Considering ��ˆ as the first item of our query-pair, we then retrieve �� queries from the MS MARCO training set Q that are most
semantically similar to ��ˆ, using a dense index of embedded representation, thus yielding �� example pairs in total. Specifically, we
use the Sentence BERT [64] bi-encoder all-MiniLM-L12-v2.
Each query-pair is assigned a binary label indicating whether it
serves as a good or bad example, as detailed in Section 4.3. Formally,
the set of queries formulated from the context ���� (��) is given by:
��ˆ = �� (���� (��), N 1
��
(��ˆ) ∪ N 0
��
(��ˆ); ��LLM), where
��ˆ = �� (���� (��); ��LLM) ∧ ��
′
∈ ��−argmax��
′ ∈Q ��(��, �� ˆ
′
)}.
(8)
In Equation 8 (○4 in Figure 2, and the prompt in Figure 4), ��ˆ is
the zero-shot query formulation (Equation 7, and the prompt in
Figure 3) from the context ���� (��), N�� (��ˆ) = N 1
��
(��ˆ) ∪ N 0
��
(��ˆ) represents the additional context for ICL comprised of �� most similar
query pairs topically related to the context out of which ��/2 are
good examples (namely N 1
��
(��ˆ)) and the remaining bad (namely
N 0
��
(��ˆ)), ��(��, �� ˆ
′
) denotes the similarity measure (specifically, cosine
similarities with all-MiniLM-L12-v2 embedding) between ��ˆ and
candidate ��
′ used to select the candidate set of �� queries (�� > ��).
4.3 Labelling the Examples
After obtaining the ��-nearest neighbourhood N (��ˆ) of the query
representation of the input context, the next step is to classify an
example pair into one of the two classes – good (1) or bad (0), i.e.,
constitute the two subsets N 1
��
(��ˆ) and N 0
��
(��ˆ) of Equation 8, and
the green and red query-pair examples shown in Figure 2. As per
the task requirement, we expect that a good reformulation is likely
to be the one where the documents retrieved by one query are
semantically related or highly overlapped but not close to being
identical as compared to the other.
To quantify the overlap between the search results of an original
query and its reformulation, we employ the rank-biased overlap
(RBO) metric [82], as shown at ○2 in Figure 2. Substantially small
RBO values (close to 0) between the retrieved documents using
documents before and after reformulation indicate substantial topical drift, whereas very high values (close to 1) suggest that the
two queries are nearly identical. In both cases, the reformulation
is unlikely to represent a meaningful evolution of the information
need. By contrast, intermediate RBO values (e.g., around 0.5) are
more indicative of valid reformulation candidates.
Specifically, from a sorted list of �� (> ��) candidate reformulations now sorted by the RBO scores (instead of the embedding
similarities as in Equation 8), we select the subset centred around
the mean candidate ��
′
��/2
and select �� candidates around the mean
to represent positive and negative examples. More formally,
��
1
��
(��ˆ′
) = {(��, �� ˆ
′
��/2−��
), . . . , (��, �� ˆ
′
��/2−1
)}
��
0
��
(��ˆ′
) = {(��, �� ˆ
′
��/2+��
), . . . , (��, �� ˆ
′
��/2+1
)}
(9)
5
SIGIR ’26, Jul 20-24, 2026, Melbourne, Naarm, Australia Anon.
5 EXPERIMENTAL SETUP
5.1 Research Questions
The proposed PIR model described in Section 4 consists of two key
components: (i) a query formulation (QF) model �� (Equation 1),
and (ii) a foundation IR model �� that consumes the output of �� to
perform retrieval over a collection. Our research questions therefore
evaluate the effectiveness of the query formulation component (��)
and how its outputs propagate and influence the performance of
the retrieval component (��).
Our first research question assesses an LLM’s ability to formulate
a query from contextually relevant information (Equation 8), mostly
on a relatively generic topic, which would be useful in retrieving
relevant documents for a future information need. Stated explicitly,
• RQ1: Does localised example query-pairs modeling good and bad
formulations (Equation 9) lead to effective query formulation?
As different IR models inherently vary in their characteristics
and often perform better for specific classes of queries, our second
research question examines which class of IR model works best
with automatically formulated queries,
• RQ2: Which class of IR model is the most effective in combination
with the ICL-based query (Equation 1)?
The third research question addresses the trade-off in PIR systems between small and large context sizes to determine the user
context (too small and the system may fail to retrieve sufficiently
relevant information; too large and it could reduce the system’s
proactivity) (Equation 6),
• RQ3: How is the effectiveness of the proposed PIR system affected by the user context size (Equation 6)?
The fourth research question investigates the role of RBO-based
selection for the good and bad examples of query reformulation
examples, particularly whether extreme RBO values (too close to 1
or 0) remain useful for the query formulation process,
• RQ4: Does the RBO-value based selection (Equation 9) play a
key role in determining the quality of the generated queries?
Our final research question examines the importance of the
number of selected query-pair examples of query reformulation,
• RQ5: Does the amount of query-pairs selected from the RBO
intermediate value (Equation 9) play a key role in improving the
effectiveness of the generated queries?
5.2 IR Models (��)
For our TREC DL and TREC COVID experiments, we evaluate four
classes of ranking models �� (Equation 3):
Sparse: Models using sparse indexes and exact term matching.
We employ BM25 [3, 65], where similarity depends on the term
frequency overlap between the document and the query, the term
collection statistics, and the document length.
Learned Sparse: Supervised rankers with sparsity constraints enforced on the learned document-term weights. As a representative
from this class, we use Splade model [28].
Retrieve-and-Rerank: Supervised cross-encoders that reranks
top documents initially retrieved by an unsupervised model (e.g.
BM25). We use Mono-T5 [58], a T5-based cross-encoder model
trained on MS MARCO training set.
Dense Indexing: Models that learn separate query and document
representations (bi-encoders), enabling dense indexing and approximating nearest neighbour search. We use ColBERT-v2 [27, 70]
and index its dense vectors with Faiss [24].
5.3 Baseline Query Formulation Methods (��)
To evaluate our proposed ICL-based query formulation approach
relative to existing approaches, we employ the following baselines
with a common hyper-parameter ��, which represents the number
of queries generated from a given context (Equation 1), whose
retrieval results are combined using RRF (Equation 2).
For a fair comparison between all the query formulation strategies, we report the results with the best settings for each.
QF-D2Q (����2�� ) involves a Doc2Query model, which is a T5 model
fine-tuned on MS MARCO query-relevant document pairs, to learn
relevance associations between two text inputs [59]. Given a context, the model is capable of generating a list of candidate queries.
In particular for our task, we found �� = 5 is optimal.
QF-SW (������ ) is a sliding window based query-term extraction
method from verbose queries as proposed in [8, 60]. Overlapping
windows of size �� and step �� (specifically, �� = 10 and �� = 5) are
slid across the text, and the top-�� scoring windows yield �� queries
(Equation 1). The optimal setting is �� = 3.
QF-RF (������ ) is a relevance feedback-based method for query formulation that uses the RM3 [34] term weights to select the top-5
terms as the query from the user context. The optimal settings for
�� (the number of queries generated in Equation 1) was found to be
1. The optimal number of feedback documents and terms for RM3
were found out to be 6 and 5, respectively.
QF-Zero (��0) - Queries are formulated using Equation 7 in a zeroshot manner (Figure 3). The optimal setting is �� = 1.
QF-Static (���� ) - An ablation of our ICL method when formulating
the final query where example query-pairs are fixed globally rather
than drawn from local context (an ablation of Figure 4). Similar to
��0, the optimal setting is �� = 1.
QF-QP (���� ) - Ablation using only the top-5 MS MARCO training
queries, without query-pairs. Again, �� = 1 leads to the highest
downstream performance (ranking effectiveness).
Oracle (��) - The oracle is the ideal query formulator, where we
input the query itself, representing an oracle situation where the
true future information need is known to the PIR system.
Each baseline operates on the same context ���� (��) formulated
from a DL or COVID query (Equation 6) and is then combined with
a specific ranking model (Section 5.2) to evaluate the downstream
retrieval performance.
As for our proposed method of QF-ICL (ICL-based QF) (����),
the best results were obtained with �� = 1, so all reported experiments use one good and one bad example of query reformulation,
and �� = 1. For QF-Zero, QF-Static, and QF-ICL, we used the
llama-3.1-8B-instruct2 LLM. It is important to note that our
approach is not limited to just this LLM, as the LLM can be interchangeable. However, we limited our proposed approach to using
only this LLM for the purpose of the experiments.
2https://huggingface.co/meta-llama/Llama-3.1-8B-Instruct
6
Generating Queries from User Contexts via In-Context Learning for Proactive Retrieval SIGIR ’26, Jul 20-24, 2026, Melbourne, Naarm, Australia
Table 1: Comparison of nDCG@10 and runtime in seconds, reported under the “�� (s)” column, for the proposed proactive search pipeline using
various standard IR rankers, against the upper bound results of the oracle and baseline query formulation methods on DL’19, ’20, and COVID.
All experiments use a context size of �� = 5 (Equation 6). Oracle results appear in gray, best results per ranker are bold, and best overall results
are underlined (paired t-test, �� < 0.05, statistical significance is represented as † between ���� and the best performing baseline ������ ).
Retriever QF Model DL’19 DL’20 COVID
Rel:{3} Rel: {2, 3} �� (s) Rel:{3} Rel: {2, 3} �� (s) Rel: {2} �� (s)
BM25
Oracle (��) .3022 .4400 0.0157 .3656 .4230 0.0999 .5201 0.0335
QF-D2Q (����2�� ) .0578 .1456 0.3234 .0743 .1134 0.2954 .0543 0.3336
QF-RF (������ ) .1154 .2477 1.0006 .1596 .2426 0.9755 .1370 1.6585
QF-SW (������ ) .0557 .1455 0.0518 .0583 .1064 0.0317 .0689 0.0223
QF-Zero (��0) .0635 .1293 0.2789 .0509 .0831 0.2981 .1021 0.4928
QF-Static (���� ) .0676 .1493 0.2938 .1092 .1760 0.2911 .1029 0.5843
QF-QP (���� ) .0313 .0810 0.4332 .0491 .0681 0.3777 .0297 0.4709
QF-ICL (����) (Ours) .1183 .2272 0.5515 .1632 .2451 0.5132 .1973† 1.0524
ColBERT
Oracle (��) .4697 .6462 0.7522 .5616 .6368 1.2640 .4287 0.0575
QF-D2Q (����2�� ) .0969 .1942 0.1694 .0744 .1134 1.1182 .0273 0.4891
QF-RF (������ ) .1175 .2262 2.6208 .1021 .1753 2.6174 .1061 1.0197
QF-SW (������ ) .0539 .1461 1.6561 .0756 .1225 1.5809 .0603 0.0883
QF-Zero (��0) .0887 .1677 1.2630 .0804 .1231 1.2714 .1217 0.5353
QF-Static (���� ) .0934 .2002 2.0458 .1346 .2089 1.2087 .1057 0.6567
QF-QP (���� ) .0582 .0968 1.2855 .0420 .0614 1.2908 .0372 0.5422
QF-ICL (����) (Ours) .1671 .3049† 1.3724 .1834†
.2570† 1.3665 .2124† 1.1194
MonoT5
Oracle (��) .3555 .5023 0.0869 .4037 .4583 0.0895 .5526 0.1460
QF-D2Q (����2�� ) .0816 .1521 0.3711 .0764 .1263 0.3590 .0475 0.9421
QF-RF (������ ) .1182 .2643 1.0512 .1688 .2487 1.0275 .1403 1.0891
QF-SW (������ ) .0493 .1310 0.0686 .0604 .1013 0.0676 .0705 0.0862
QF-Zero (��0) .0720 .1363 0.3514 .0500 .0919 0.3740 .1046 0.6156
QF-Static (���� ) .0895 .1613 0.3378 .1097 .1891 0.3622 .1077 0.7223
QF-QP (���� ) .0451 .0889 0.4715 .0479 .0676 0.4537 .0305 0.6073
QF-ICL (����) (Ours) .1497 .2563 0.5661 .1752 .2579 0.5501 .2057† 1.1820
Splade
Oracle (��) .4916 .6480 1.1231 .5874 .6523 1.0892 .4798 0.1137
QF-D2Q (����2�� ) .0919 .1760 1.2959 .0672 .1222 1.2846 .0315 0.8227
QF-RF (������ ) .1176 .2403 1.3312 .1446 .2289 1.3553 .0946 1.0196
QF-SW (������ ) .0731 .1619 2.2801 .0645 .1271 2.2451 .0660 0.2007
QF-Zero (��0) .0831 .1613 0.9414 .0652 .1114 0.9538 .1114 0.5941
QF-Static (���� ) .1139 .2179 1.3435 .1382 .2237 1.1992 .1070 0.7156
QF-QP (���� ) .0528 .0998 1.2351 .0299 .0564 1.2101 .0414 0.5633
QF-ICL (����) (Ours) .2058†
.3404† 1.1943 .2157†
.3068† 1.1967 .2088† 1.1721
6 RESULTS
Our first set of results corresponds to the research questions RQ1
and RQ2, i.e., what is the most effective PIR model configuration, in
terms of the query formulator and the ranker components. Table 1
reports the performance across all IR models and query formulation methods experimented with. When used with Splade, our
method significantly outperforms ������ across all datasets. With
ColBERT, it surpassed ������ on TREC DL’19 when retrieving somewhat relevant and highly relevant documents, and remains superior
across all remaining datasets. In contrast, with BM25 and MonoT5,
the improvements over ������ are statistically significant only on
TREC COVID. This is likely because both BM25 and MonoT5 have
nDCG10 effectiveness close to ������ , as shown in Table 1.
The statistical baselines ����2�� and ������ perform poorly for this
task. This is likely because these approaches are capable of enriching an information need rather than suggesting ways in which it
may evolve, and that relevance along does not play a key role in the
task of information need prediction. However, the RM3 relevancefeedback method ������ performs relatively close to, and occasionally
exceeds, ���� for somewhat relevant and highly relevant documents
on DL’19 when using BM25 or MonoT5. Since RM3 draws expansion
terms from the top retrieved documents, it is capable of enriching
an information need, and can improve recall by capturing surfacelevel lexical overlap with the evolving information need. Our ICL
method ���� operates differently, as it produces semantically richer
terms, which results in retrieving more highly relevant documents.
Although the improvement over ������ is not statistically significant
with BM25 and MonoT5, the results nonetheless indicate that ����
better captures the user’s evolving information need.
Across all datasets and retrievers, ���� consistently outperforms
the other LLM-based formulation baselines, zero-shot ��0, static
��-shot, and query-only baselines ���� . Additionally, both ���� and ����
outperform ���� across all settings, empirically validating that the use
of query-pair examples is beneficial for effective query formulation
from a user context.
7
SIGIR ’26, Jul 20-24, 2026, Melbourne, Naarm, Australia Anon.
The static ��-shot baseline (���� ) performs better result than both
the 0-shot (��0) and query-only (���� ) baselines, confirming the usefulness of query formulation examples. However, its performance
is substantially weaker than that of the localised ICL approach ����,
indicating that topically related examples are far more effective
than generic ones for guiding the LLM query formulation process.
Our experiments thus answer RQ1 in the affirmative and establish
that an LLM-based approach with examples of query formulations
to guide the generation process is the most effective strategy overall.
Regarding RQ2, Table 1 shows that the proposed ICL-based
query formulator (����) offers a consistent, strong performance across
ranking models, particularly for highly relevant documents, making
it broadly suitable across rankers. Notably, although Splade performs best overall, it is not always the strongest retriever. ColBERT
often performs better with the estimated queries from the TREC
DL’19 context. Thus, there is no one single answer to RQ2 as both
ColBERT and Splade turn out to be the best performing retrievers for
PIR, depending on the latent query characteristics.
As expected, the oracle system (which is not a PIR model as the
system knows the true query) achieves the highest performance,
with a substantial difference between the best PIR model. This
highlights the difficulty of the query formulation task and indicates
a scope for improvement.
Beyond the results in Table 1, Figure 5 reports the per-query
performance for ColBERT and Splade, the two strongest rankers.
Although ���� underperforms against the oracle on average, there are
cases where it remarkably surpasses the oracle despite not having
access to the true queries.
Effectiveness versus Efficiency. When comparing the runtime
(�� (��)), ����, RM3 (������ ), and Sliding Window (������ ) stand out. Empirically, ������ is slower to complete the query formulation and retrieval
on two of the three datasets, reflecting the extra retrieval/feedback
iterations it performs. These recorded times, however, must be interpreted in light of the significantly higher computational cost of
running LLMs for ����.
Despite this, ���� delivers an improvement in retrieval quality
when compared against the baselines across all datasets and retrievers, as shown in Table 1. We therefore see the increased computational cost as a reasonable trade-off. Future work may focus
on optimising the efficiency of our proposed approach to reduce
both the computational overhead and the time taken for both query
formulation and retrieval.
Sensitivity to Context Size. To evaluate a realistic scenario, we
examine what the effective context size our proposed proactive
system needs to effectively formulate queries and retrieve highly
relevant results to the user. Notably, as the performance of a PIR
model depends on the context itself, we also investigate the variability by sampling five different document sets, shown as box plots in
Figure 6. Figure 6 visualises how performance changes with context
size ��, which reflects the depth of user interactions as well as the
system’s focus on the context. We see the effectiveness improve
steadily as �� increases up to 5, after which performance declines,
suggesting that larger contexts make it harder for the model to
identify the user’s actual information need, potentially due to the
noise it might encounter in this larger context.
Hence, to answer RQ3, we conclude that various PIR models
consistently prefer a moderate size of context – large enough to
0.0 0.2 0.4 0.6 0.8 1.0
QF-ICL
0.0
0.2
0.4
0.6
0.8
1.0
Oracle
ColBERT - DL19
0.0 0.2 0.4 0.6 0.8 1.0
QF-ICL
0.0
0.2
0.4
0.6
0.8
1.0
SPLADE - DL19
0.0 0.2 0.4 0.6 0.8 1.0
QF-ICL
0.0
0.2
0.4
0.6
0.8
1.0
Oracle
ColBERT - DL20
0.0 0.2 0.4 0.6 0.8 1.0
QF-ICL
0.0
0.2
0.4
0.6
0.8
1.0
SPLADE - DL20
0.0 0.2 0.4 0.6 0.8 1.0
QF-ICL
0.0
0.2
0.4
0.6
0.8
1.0
Oracle
ColBERT - COVID
0.0 0.2 0.4 0.6 0.8 1.0
QF-ICL
0.0
0.2
0.4
0.6
0.8
1.0
SPLADE - COVID
Figure 5: Per-query nDCG@10 effectiveness of the Oracle and QFICL on DL’19, ’20, and COVID. QF-ICL outperforms the Oracle under
certain queries.
accurately capture the user’s information need, but not so large
that topical diversity may lead to difficulty in query formulation.
Ablation for intermediate RBO value based example selection. To answer RQ4 and empirically validate our expectation that
examples with intermediate RBO values—those near the median
among the candidate queries—are critical to the performance of
a PIR model, we conduct two ablation studies. The first uses only
low-RBO examples (RBO-L), corresponding to query pairs that are
topically distinct, and the second uses only high-RBO examples
(RBO-H), representing queries with nearly identical information
needs. Table 2 compares these settings to our median-based selection (RBO-M), which we also report in the table to facilitate
relative comparisons. High-RBO examples constrain the LLM to a
narrow domain, limiting its ability to explore alternative ways in
which a user’s information need might evolve. Low-RBO examples
introduce excessive topic diversity, reducing the LLM’s ability to
accurately focus on the evolving information need. In contrast, our
proposed median-based selection-using good and bad examples
near the median from both ends of the RBO-spectrum, yields substantially better performance, demonstrating not only that both
8
Generating Queries from User Contexts via In-Context Learning for Proactive Retrieval SIGIR ’26, Jul 20-24, 2026, Melbourne, Naarm, Australia
1 2 3 4 5 6 7 8 9 10
m
0.00
0.05
0.10
0.15
0.20
0.25
nDCG@10
BM25
1 2 3 4 5 6 7 8 9 10
m
0.00
0.05
0.10
0.15
0.20
0.25
ColBERT
1 2 3 4 5 6 7 8 9 10
m
0.00
0.05
0.10
0.15
0.20
0.25
nDCG@10
MonoT5
1 2 3 4 5 6 7 8 9 10
m
0.00
0.05
0.10
0.15
0.20
0.25
SPLADE
Figure 6: Effect of context size�� (Equation 6) on QF-ICL performance
on the combined set of DL’19, ’20, and COVID queries. It is evident
by observing the means of each ablation, that QF-ICL performs at
its best when �� = 5 as we obtain the highest mean.
Table 2: Relative comparison of nDCG@10 and runtime in seconds,
reported under the “�� (s)” column, for QF-ICL where examples are
selected only from the lower (RBO-L) or upper RBO (RBO-H) ranges
(close to 0 or 1). Using both good and bad examples (RBO-M) is
optimal.
Retriever QF Model DL’19 DL’20 COVID
Rel:{3} �� (s) Rel:{3} �� (s) Rel:{2} �� (s)
BM25
RBO-H .0357 0.5534 .0727 0.5563 .1072 1.0351
RBO-M .1183 0.5515 .1632 0.5132 .1973 1.0524
RBO-L .0706 0.5606 .0738 0.5726 .1111 1.0150
ColBERT
RBO-H .0584 1.9842 .0562 2.1964 .1153 1.0685
RBO-M .1671 1.3724 .1834 1.3665 .2124 1.1194
RBO-L .0895 1.9826 .0715 2.2018 .1129 1.0493
MonoT5
RBO-H .0498 0.6339 .0694 0.6368 .1144 1.1603
RBO-M .1497 0.5661 .1752 0.5501 .2057 1.1820
RBO-L .0812 0.6426 .0775 0.6562 .1122 1.1366
Splade
RBO-H .0693 1.2363 .0566 1.2787 .1147 1.1453
RBO-M .2058 1.1943 .2157 1.1967 .2088 1.1721
RBO-L .0943 1.2308 .0626 1.2333 .1218 1.1226
types of examples are necessary, but also that an RBO-based selection
strategy is effective in practice.
Sensitivity on the number of query-pairs (��). To answer RQ5
and empirically validate our expectation that providing a small
number of query-pair examples are critical to the performance of a
PIR model, we conduct four sensitivity studies. For each sensitivity study, we select 3, 5, 7, and 10 respectively. Figure 7 presents
the results with these sensitivity changes, while also reporting
the original value of �� = 1 to facilitate relative comparisons and
investigating the variability by sampling five different document
1 3 5 7 10
p
0.00
0.05
0.10
0.15
0.20
0.25
nDCG@10
BM25
1 3 5 7 10
p
0.00
0.05
0.10
0.15
0.20
0.25
ColBERT
1 3 5 7 10
p
0.00
0.05
0.10
0.15
0.20
0.25
nDCG@10
MonoT5
1 3 5 7 10
p
0.00
0.05
0.10
0.15
0.20
0.25
SPLADE
Figure 7: Effect of number of selected query-pairs �� (Equation 9) on
QF-ICL performance on the combined set of DL’19, ’20, and COVID
queries. It is evident by observing the means of each ablation, that
QF-ICL performs best when �� = 1.
sets, shown as box plots. As �� increases, the diversity in query-pair
examples, as well as the noise that is exposed to the LLM also increases, which reduces its ability to accurately focus on the evolving
information need. By contrast, our proposed setting of �� = 1 yields
substantially better performance. This demonstrates that selecting
a minimum amount of query-pairs is effective in practice.
7 CONCLUSIONS AND FUTURE WORK
We advanced proactive information retrieval by establishing a reproducible simulated environment, using TREC DL and TREC COVID
datasets, for systematically testing proactive systems using only
partially and topically related documents as user context, without
access to the original query.
We also proposed an in-context learning (ICL) based approach
for query formulation from the user context, hypothesising that a
number of query-pairs extracted from a query log, that reflect how a
user’s information need can evolve, can effectively guide the query
generation process. Our proposed approach outperforms most baselines across the simulated environment, retrieving a higher proportion of highly relevant documents, and consistently narrowing the
gap to an oracle system across multiple ranking models, particularly
with learned sparse and dense retrievers.
Future work could explore using LLM judges with access to
oracle information [50], to reduce false penalisations of various
ways the user’s information need can evolve. We also want to
explore user simulations with simulated personalised relevance
assessments. While the effectiveness gains appear to justify the
cost, future research should explore strategies for reducing computational overhead in highly-effective PIR systems.
9
SIGIR ’26, Jul 20-24, 2026, Melbourne, Naarm, Australia Anon.
REFERENCES
[1] Wasi Uddin Ahmad, Kai-Wei Chang, and Hongning Wang. 2019. Context Attentive Document Ranking and Query Suggestion. In Proceedings of SIGIR. ACM,
New York, NY, USA, 385–394.
[2] Mohammad Aliannejadi, Hamed Zamani, Fabio Crestani, and W Bruce Croft. 2019.
Asking clarifying questions in open-domain information-seeking conversations.
In Proceedings of the 42nd international acm sigir conference on research and
development in information retrieval. 475–484.
[3] Giambattista Amati. 2009. BM25. Springer US, Boston, MA, 257–260. https:
//doi.org/10.1007/978-0-387-39940-9_921
[4] Mozhdeh Ariannezhad, Ali Montazeralghaem, Hamed Zamani, and Azadeh Shakery. 2017. Improving Retrieval Performance for Verbose Queries via Axiomatic
Analysis of Term Discrimination Heuristic. In Proc. of SIGIR. Association for
Computing Machinery, New York, NY, USA, 1201–1204.
[5] Payal Bajaj, Daniel Campos, Nick Craswell, Li Deng, Jianfeng Gao, Xiaodong
Liu, Rangan Majumder, Andrew McNamara, Bhaskar Mitra, Tri Nguyen, Mir
Rosenberg, Xia Song, Alina Stoica, Saurabh Tiwary, and Tong Wang. 2018.
MS MARCO: A Human Generated MAchine Reading COmprehension Dataset.
arXiv:cs.CL/1611.09268 https://arxiv.org/abs/1611.09268
[6] Elena Barsky and Judit Bar-Ilan. 2005. From the search problem through query
formulation to results on the web. Online Information Review 29, 1 (2005), 75–89.
[7] Nicolas J. Belkin. 2000. Helping people find what they don’t know. Commun.
ACM 43, 8 (Aug. 2000), 58–61. https://doi.org/10.1145/345124.345143
[8] Michael Bendersky and W. Bruce Croft. 2008. Discovering Key Concepts in
Verbose Queries. In Proceedings of the 31st Annual International ACM SIGIR
Conference on Research and Development in Information Retrieval (SIGIR ’08).
ACM, New York, NY, USA, 491–498. https://doi.org/10.1145/1390334.1390419
[9] Sumit Bhatia, Debapriyo Majumdar, and Nitish Aggarwal. 2016. Proactive Information Retrieval: Anticipating Users’ Information Need. In Advances in Information Retrieval, Nicola Ferro, Fabio Crestani, Marie-Francine Moens, Josiane
Mothe, Fabrizio Silvestri, Giorgio Maria Di Nunzio, Claudia Hauff, and Gianmaria
Silvello (Eds.). Springer International Publishing, Cham, 874–877.
[10] Sumit Bhatia, Debapriyo Majumdar, and Nitish Aggarwal. 2016. Proactive Information Retrieval: Anticipating Users’ Information Need. In Advances in Information Retrieval - 38th European Conference on IR Research, ECIR 2016, Padua,
Italy, March 20-23, 2016. Proceedings (Lecture Notes in Computer Science), Nicola
Ferro, Fabio Crestani, Marie-Francine Moens, Josiane Mothe, Fabrizio Silvestri,
Giorgio Maria Di Nunzio, Claudia Hauff, and Gianmaria Silvello (Eds.), Vol. 9626.
Springer, 874–877. https://doi.org/10.1007/978-3-319-30671-1_84
[11] Keping Bi, Qingyao Ai, Yongfeng Zhang, and W. Bruce Croft. 2019. Conversational
Product Search Based on Negative Feedback. In Proceedings of the 28th ACM
International Conference on Information and Knowledge Management (Beijing,
China) (CIKM ’19). Association for Computing Machinery, New York, NY, USA,
359–368. https://doi.org/10.1145/3357384.3357939
[12] Paolo Boldi, Francesco Bonchi, Carlos Castillo, Debora Donato, Aristides Gionis,
and Sebastiano Vigna. 2008. The Query-flow Graph: Model and Applications. In
Proceedings of CIKM. ACM, New York, NY, USA, 609–618.
[13] Francesco Bonchi, Raffaele Perego, Fabrizio Silvestri, Hossein Vahabi, and
Rossano Venturini. 2012. Efficient Query Recommendations in the Long Tail
via Center-piece Subgraphs. In Proceedings of SIGIR. ACM, New York, NY, USA,
345–354.
[14] Tom Brown, Benjamin Mann, Nick Ryder, Melanie Subbiah, Jared D Kaplan,
Prafulla Dhariwal, Arvind Neelakantan, Pranav Shyam, Girish Sastry, Amanda
Askell, et al. 2020. Language models are few-shot learners. Advances in neural
information processing systems 33 (2020), 1877–1901.
[15] Ben Carterette, Evangelos Kanoulas, Mark M. Hall, and Paul D. Clough. 2014.
Overview of the TREC 2014 Session Track. In Proceedings of The Twenty-Third
Text REtrieval Conference, TREC 2014, Gaithersburg, Maryland, USA, November
19-21, 2014 (NIST Special Publication), Ellen M. Voorhees and Angela Ellis (Eds.),
Vol. 500-308. National Institute of Standards and Technology (NIST).
[16] Haonan Chen, Zhicheng Dou, Yutao Zhu, Zhao Cao, Xiaohua Cheng, and JiRong Wen. 2022. Enhancing User Behavior Sequence Modeling by Generative Tasks for Session Search. In Proceedings of the 31st ACM International Conference on Information & Knowledge Management (Atlanta, GA, USA) (CIKM
’22). Association for Computing Machinery, New York, NY, USA, 180–190.
https://doi.org/10.1145/3511808.3557310
[17] Jidong Chen, Hang Guo, Wentao Wu, and Chunxin Xie. [n.d.]. Search Your
Memory! - An Associative Memory Based Desktop Search System. In Proc. of
SIGMOD. 1099–1102.
[18] Wanyu Chen, Fei Cai, Honghui Chen, and Maarten de Rijke. 2018. Attentionbased Hierarchical Neural Query Suggestion. In Proceedings of SIGIR. ACM, New
York, NY, USA.
[19] Gordon V Cormack, Charles LA Clarke, and Stefan Buettcher. 2009. Reciprocal
rank fusion outperforms condorcet and individual rank learning methods. In
Proceedings of the 32nd international ACM SIGIR conference on Research and
development in information retrieval. 758–759.
[20] Gordon V. Cormack, Charles L A Clarke, and Stefan Buettcher. 2009. Reciprocal
rank fusion outperforms condorcet and individual rank learning methods. In
Proceedings of the 32nd International ACM SIGIR Conference on Research and
Development in Information Retrieval (Boston, MA, USA) (SIGIR ’09). Association
for Computing Machinery, New York, NY, USA, 758–759. https://doi.org/10.
1145/1571941.1572114
[21] Nick Craswell, Bhaskar Mitra, Emine Yilmaz, Daniel Campos, and Ellen Voorhees.
2019. Overview of the TREC 2019 deep learning track. In TREC 2019.
[22] W. Bruce Croft and R. H. Thompson. 1987. I3R: A new approach to the design
of document retrieval systems. J. Am. Soc. Inf. Sci. 38 (1987), 389–404. https:
//api.semanticscholar.org/CorpusID:27237570
[23] C. J. Crouch, D. B. Crouch, and K. R. Nareddy. 1990. The Automatic Generation
of Extended Queries. In Proc. of SIGIR (Brussels, Belgium). 369–383.
[24] Matthijs Douze, Alexandr Guzhva, Chengqi Deng, Jeff Johnson, Gergely Szilvasy,
Pierre-Emmanuel Mazaré, Maria Lomeli, Lucas Hosseini, and Hervé Jégou. 2024.
The Faiss library. (2024). arXiv:cs.LG/2401.08281
[25] Susan T. Dumais, Edward Cutrell, Jonathan J. Cadiz, Gavin Jancke, Raman Sarin,
and Daniel C. Robbins. 2015. Stuff I’ve Seen: A System for Personal Information
Retrieval and Re-Use. SIGIR Forum 49, 2 (2015), 28–35.
[26] Henry Feild and James Allan. 2013. Task-aware Query Recommendation. In
Proceedings of SIGIR. ACM, New York, NY, USA, 83–92.
[27] Thibault Formal, Benjamin Piwowarski, and Stéphane Clinchant. 2020. A White
Box Analysis of ColBERT. CoRR abs/2012.09650 (2020). arXiv:2012.09650 https:
//arxiv.org/abs/2012.09650
[28] Thibault Formal, Benjamin Piwowarski, and Stéphane Clinchant. 2021. SPLADE:
Sparse Lexical and Expansion Model for First Stage Ranking. In Proceedings
of the 44th International ACM SIGIR Conference on Research and Development
in Information Retrieval (Virtual Event, Canada) (SIGIR ’21). Association for
Computing Machinery, New York, NY, USA, 2288–2292. https://doi.org/10.1145/
3404835.3463098
[29] Debasis Ganguly, Manisha Ganguly, Johannes Leveling, and Gareth J.F. Jones.
2013. TopicVis: a GUI for topic-based feedback and navigation. In Proceedings
of the 36th International ACM SIGIR Conference on Research and Development in
Information Retrieval (Dublin, Ireland) (SIGIR ’13). Association for Computing
Machinery, New York, NY, USA, 1103–1104. https://doi.org/10.1145/2484028.
2484202
[30] Fred.X Han, Di Niu, Kunfeng Lai, Weidong Guo, Yancheng He, and Yu Xu. 2019.
Inferring Search Queries from Web Documents via a Graph-Augmented Sequence
to Attention Network. In The World Wide Web Conference. 2792–2798.
[31] Helia Hashemi, Hamed Zamani, and W. Bruce Croft. 2020. Guided Transformer:
Leveraging Multiple External Sources for Representation Learning in Conversational Search. In Proceedings of the 43rd International ACM SIGIR Conference on
Research and Development in Information Retrieval (Virtual Event, China) (SIGIR
’20). Association for Computing Machinery, New York, NY, USA, 1131–1140.
https://doi.org/10.1145/3397271.3401061
[32] Ahmed Hassan Awadallah, Ryen W. White, Patrick Pantel, Susan T. Dumais, and
Yi-Min Wang. 2014. Supporting Complex Search Tasks. In Proceedings of CIKM.
ACM, New York, NY, USA, 829–838.
[33] Yuta Imasaka and Hideo Joho. 2024. Effect of LLM’s Personality Traits on Query
Generation. In Proceedings of the 2024 Annual International ACM SIGIR Conference
on Research and Development in Information Retrieval in the Asia Pacific Region.
249–258.
[34] Nasreen Abdul Jaleel, James Allan, W. Bruce Croft, Fernando Diaz, Leah S. Larkey,
Xiaoyan Li, Mark D. Smucker, and Courtney Wade. 2004. UMass at TREC 2004:
Novelty and HARD. In Proceedings of the Thirteenth Text REtrieval Conference,
TREC 2004, Gaithersburg, Maryland, USA, November 16-19, 2004 (NIST Special
Publication), Ellen M. Voorhees and Lori P. Buckland (Eds.), Vol. 500-261. National
Institute of Standards and Technology (NIST). http://trec.nist.gov/pubs/trec13/
papers/umass.novelty.hard.pdf
[35] Jyun-Yu Jiang and Wei Wang. 2018. RIN: Reformulation inference network for
context-aware query suggestion. In Proceedings of the 27th ACM international
conference on information and knowledge management. 197–206.
[36] Hideo Joho and Joemon M Jose. 2025. An Instruction-Response Perspective on
Large Language Models in Information Retrieval Tasks. In Proceedings of the 48th
International ACM SIGIR Conference on Research and Development in Information
Retrieval (Padua, Italy) (SIGIR ’25). Association for Computing Machinery, New
York, NY, USA, 3843–3852. https://doi.org/10.1145/3726302.3730346
[37] Evangelos Kanoulas, Ben Carterette, Paul D. Clough, and Mark Sanderson. 2011.
Evaluating Multi-query Sessions. In Proceedings of SIGIR 2011. ACM, New York,
NY, USA, 1053–1062.
[38] Anton Korikov, Scott Sanner, Yashar Deldjoo, Zhankui He, Julian McAuley, Arnau
Ramisa, René Vidal, Mahesh Sathiamoorthy, Atoosa Kasrizadeh, Silvia Milano,
and Francesco Ricci. 2024. Large Language Model Driven Recommendation. ArXiv
abs/2408.10946 (2024). https://api.semanticscholar.org/CorpusID:271909034
[39] Markus Koskela, Petri Luukkonen, Tuukka Ruotsalo, Mats Sjöberg, and Patrik
Floréen. 2018. Proactive Information Retrieval by Capturing Search Intent from
Primary Task Context. ACM Trans. Interact. Intell. Syst. 8, 3 (2018), 20:1–20:25.
10
Generating Queries from User Contexts via In-Context Learning for Proactive Retrieval SIGIR ’26, Jul 20-24, 2026, Melbourne, Naarm, Australia
[40] Chia-Jung Lee and W. Bruce Croft. 2012. Generating Queries from User-Selected
Text. In Proc. of the 4th Information Interaction in Context Symposium. 100–109.
[41] Jing Yang Lee, Seokhwan Kim, Kartik Mehta, Jiun-Yu Kao, Yu-Hsiang Lin, and
Arpit Gupta. 2024. Redefining Proactivity for Information Seeking Dialogue. In
Proceedings of the Second Workshop on Social Influence in Conversations (SICon
2024), James Hale, Kushal Chawla, and Muskan Garg (Eds.). Association for
Computational Linguistics, Miami, Florida, USA, 64–84. https://doi.org/10.18653/
v1/2024.sicon-1.5
[42] Lei Li, Yongfeng Zhang, Dugang Liu, and Li Chen. 2024. Large Language
Models for Generative Recommendation: A Survey and Visionary Discussions.
arXiv:cs.IR/2309.01157 https://arxiv.org/abs/2309.01157
[43] Qinyao Li, Xiaoyang Zheng, Qihang Zhao, Ke Xu, Zhongbo Sun, Chao Wang,
Chenyi Lei, Han Li, and Wenwu Ou. 2025. DiffusionGS: Generative Search
with Query Conditioned Diffusion in Kuaishou. ArXiv abs/2508.17754 (2025).
https://api.semanticscholar.org/CorpusID:280711588
[44] Ruirui Li, Ben Kao, Bin Bi, Reynold Cheng, and Eric Lo. 2012. DQR: A Probabilistic
Approach to Diversified Query Recommendation. In Proceedings of CIKM. ACM,
New York, NY, USA, 16–25.
[45] Tianle Li, Xueguang Ma, Alex Zhuang, Yu Gu, Yu Su, and Wenhu Chen. 2023. Fewshot In-context Learning on Knowledge Base Question Answering. In Proceedings
of the 61st Annual Meeting of the Association for Computational Linguistics (Volume
1: Long Papers), Anna Rogers, Jordan Boyd-Graber, and Naoaki Okazaki (Eds.).
Association for Computational Linguistics, Toronto, Canada, 6966–6980. https:
//doi.org/10.18653/v1/2023.acl-long.385
[46] Jimmy Lin, Rodrigo Nogueira, and Andrew Yates. 2021. Pretrained Transformers
for Text Ranking: BERT and Beyond. Morgan & Claypool Publishers. https:
//doi.org/10.2200/S01123ED1V01Y202108HLT053
[47] Jiqun Liu, Matthew Mitsui, Nicholas J. Belkin, and Chirag Shah. 2019. Task,
Information Seeking Intentions, and User Behavior: Toward A Multi-level Understanding of Web Search. In Proceedings of the 2019 Conference on Human
Information Interaction and Retrieval, CHIIR 2019, Glasgow, Scotland, UK, March
10-14, 2019, Leif Azzopardi, Martin Halvey, Ian Ruthven, Hideo Joho, Vanessa
Murdock, and Pernilla Qvarfordt (Eds.). ACM, 123–132. https://doi.org/10.1145/
3295750.3298922
[48] Yixin Liu, Kejian Shi, Katherine He, Longtian Ye, Alexander Fabbri, Pengfei Liu,
Dragomir Radev, and Arman Cohan. 2024. On Learning to Summarize with
Large Language Models as References. In Proceedings of the 2024 Conference of the
North American Chapter of the Association for Computational Linguistics: Human
Language Technologies (Volume 1: Long Papers), Kevin Duh, Helena Gomez, and
Steven Bethard (Eds.). Association for Computational Linguistics, Mexico City,
Mexico, 8647–8664. https://doi.org/10.18653/v1/2024.naacl-long.478
[49] Petri Luukkonen, Markus Koskela, and Patrik Floréen. 2016. LSTM-Based
Predictions for Proactive Information Retrieval. ArXiv abs/1606.06137 (2016).
https://api.semanticscholar.org/CorpusID:16519388
[50] Sean MacAvaney and Luca Soldaini. 2023. One-Shot Labeling for Automatic Relevance Estimation. In Proceedings of the 46th International ACM SIGIR Conference
on Research and Development in Information Retrieval, SIGIR 2023, Taipei, Taiwan, July 23-27, 2023, Hsin-Hsi Chen, Wei-Jou (Edward) Duh, Hen-Hsen Huang,
Makoto P. Kato, Josiane Mothe, and Barbara Poblete (Eds.). ACM, 2230–2235.
https://doi.org/10.1145/3539618.3592032
[51] Chuan Meng, Francesco Tonolini, Fengran Mo, Nikolaos Aletras, Emine Yilmaz,
and Gabriella Kazai. 2025. Bridging the Gap: From Ad-hoc to Proactive Search
in Conversations. In Proceedings of the 48th International ACM SIGIR Conference
on Research and Development in Information Retrieval (Padua, Italy) (SIGIR ’25).
Association for Computing Machinery, New York, NY, USA, 64–74. https://doi.
org/10.1145/3726302.3729915
[52] Bhaskar Mitra, Milad Shokouhi, Filip Radlinski, and Katja Hofmann. 2014. On
User Interactions with Query Auto-completion. In Proceedings of SIGIR. ACM,
New York, NY, USA, 1055–1058.
[53] Fengran Mo, Kelong Mao, Yutao Zhu, Yihong Wu, Kaiyu Huang, and Jian-Yun Nie.
2023. ConvGQR: Generative Query Reformulation for Conversational Search.
In Proceedings of the 61st Annual Meeting of the Association for Computational
Linguistics (Volume 1: Long Papers). 4998–5012.
[54] Fengran Mo, Chen Qu, Kelong Mao, Tianyu Zhu, Zhan Su, Kaiyu Huang, and JianYun Nie. 2024. History-Aware Conversational Dense Retrieval. In Annual Meeting
of the Association for Computational Linguistics. https://api.semanticscholar.org/
CorpusID:267321005
[55] Sophie Monchaux, Franck Amadieu, Aline Chevalier, and Claudette Mariné.
2015. Query strategies during information searching: Effects of prior domain
knowledge and complexity of the information problems to be solved. Information
Processing & Management 51, 5 (2015), 557–569.
[56] Cristina Ioana Muntean, Franco Maria Nardini, Raffaele Perego, Guido Rocchietti,
and Cosimo Rulli. 2025. Efficient Conversational Search via Topical Locality in
Dense Retrieval. ArXiv abs/2504.21507 (2025). https://api.semanticscholar.org/
CorpusID:278207610
[57] Cristina Ioana Muntean, Franco Maria Nardini, Fabrizio Silvestri, and Marcin
Sydow. 2013. Learning to Shorten Query Sessions. In Proceedings of WWW. ACM,
New York, NY, USA, 131–132.
[58] Rodrigo Nogueira, Zhiying Jiang, and Jimmy Lin. 2020. Document Ranking
with a Pretrained Sequence-to-Sequence Model. CoRR abs/2003.06713 (2020).
arXiv:2003.06713 https://arxiv.org/abs/2003.06713
[59] Rodrigo Nogueira, Wei Yang, Jimmy Lin, and Kyunghyun Cho. 2019. Document
Expansion by Query Prediction. arXiv:cs.IR/1904.08375 https://arxiv.org/abs/
1904.08375
[60] Dipasree Pal and Debasis Ganguly. 2021. Effective Query Formulation in Conversation Contextualization: A Query Specificity-based Approach. In Proceedings of
the 2021 ACM SIGIR International Conference on Theory of Information Retrieval
(Virtual Event, Canada) (ICTIR ’21). Association for Computing Machinery, New
York, NY, USA, 177–183. https://doi.org/10.1145/3471158.3472237
[61] Enrico Palumbo, Andreas Damianou, Alice Wang, Alva Liu, Ghazal Fazelnia,
Francesco Fabbri, Rui Ferreira, Fabrizio Silvestri, Hugues Bouchard, Claudia
Hauff, Mounia Lalmas, Ben Carterette, Praveen Chandar, and David Nyhan. 2023.
Graph Learning for Exploratory Query Suggestions in an Instant Search System.
In CIKM. ACM, 4780–4786.
[62] Haojie Pan, Cen Chen, Chengyu Wang, Minghui Qiu, Liu Yang, Feng Ji, and
Jun Huang. 2021. Learning to Expand: Reinforced Response Expansion for
Information-seeking Conversations. In Proceedings of the 30th ACM International
Conference on Information & Knowledge Management (Virtual Event, Queensland,
Australia) (CIKM ’21). Association for Computing Machinery, New York, NY,
USA, 4055–4064. https://doi.org/10.1145/3459637.3481932
[63] Andrew Parry, Debasis Ganguly, and Manish Chandra. 2024. “In-Context
Learning” or: How I learned to stop worrying and love “Applied Information
Retrieval”. In Proceedings of the 47th International ACM SIGIR Conference on
Research and Development in Information Retrieval (SIGIR 2024). ACM, 14–25.
https://doi.org/10.1145/3626772.3657842
[64] Nils Reimers and Iryna Gurevych. 2019. Sentence-BERT: Sentence Embeddings
using Siamese BERT-Networks. arXiv:cs.CL/1908.10084 https://arxiv.org/abs/
1908.10084
[65] Stephen Robertson and Hugo Zaragoza. 2009. The Probabilistic Relevance Framework: BM25 and Beyond. (2009), 333–389.
[66] Kevin Ros, Matthew Jin, Jacob Levine, and ChengXiang Zhai. 2023. Retrieving Webpages Using Online Discussions. In Proceedings of the 2023 ACM SIGIR
International Conference on Theory of Information Retrieval (Taipei, Taiwan) (ICTIR ’23). Association for Computing Machinery, New York, NY, USA, 159–168.
https://doi.org/10.1145/3578337.3605139
[67] Corbin Rosset, Chenyan Xiong, Xia Song, Daniel Campos, Nick Craswell, Saurabh
Tiwary, and Paul Bennett. 2020. Leading Conversational Search by Suggesting Useful Questions. In Proceedings of The Web Conference 2020 (Taipei, Taiwan) (WWW ’20). Association for Computing Machinery, New York, NY, USA,
1160–1170. https://doi.org/10.1145/3366423.3380193
[68] Tuukka Ruotsalo, Jaakko Peltonen, Manuel JA Eugster, Dorota Głowacka, Patrik
Floréen, Petri Myllymäki, Giulio Jacucci, and Samuel Kaski. 2018. Interactive
intent modeling for exploratory search. ACM Transactions on Information Systems
(TOIS) 36, 4 (2018), 1–46.
[69] Chris Samarinas and Hamed Zamani. 2024. ProCIS: A benchmark for proactive
retrieval in conversations. In Proceedings of the 47th International ACM SIGIR
Conference on Research and Development in Information Retrieval. 830–840.
[70] Keshav Santhanam, Omar Khattab, Jon Saad-Falcon, Christopher Potts, and Matei
Zaharia. 2021. ColBERTv2: Effective and Efficient Retrieval via Lightweight Late
Interaction. CoRR abs/2112.01488 (2021). arXiv:2112.01488 https://arxiv.org/abs/
2112.01488
[71] Procheta Sen. 2022. Proactive information retrieval. SIGIR Forum 55, 2, Article
25 (March 2022), 2 pages. https://doi.org/10.1145/3527546.3527576
[72] Procheta Sen, Debasis Ganguly, and Gareth Jones. 2018. Procrastination is the
Thief of Time: Evaluating the Effectiveness of Proactive Search Systems. In
Proceedings of SIGIR. ACM, New York, NY, USA, 1157–1160.
[73] Nilanjan Sinhababu, Andrew Parry, Debasis Ganguly, Debasis Samanta, and
Pabitra Mitra. 2024. Few-shot Prompting for Pairwise Ranking: An Effective NonParametric Retrieval Model. In EMNLP (Findings). Association for Computational
Linguistics, 12363–12377.
[74] Marc Sloan, Grace Hui Yang, and Jun Wang. 2015. A term-based methodology
for query reformulation understanding. Information Retrieval Journal 18 (2015),
145 – 165. https://api.semanticscholar.org/CorpusID:5925598
[75] Gabriel L. Somlo and Adele E. Howe. 2003. Using Web Helper Agent Profiles
in Query Generation. In Proc. of the Second International Joint Conference on
Autonomous Agents and Multiagent Systems. 812–818.
[76] Toru Takaki, Atsushi Fujii, and Tetsuya Ishikawa. 2004. Associative document
retrieval by query subtopic analysis and its application to invalidity patent search.
In Proc. of CIKM’04. 399–405.
[77] Yuting Tang, Ratish Puduppully, Zhengyuan Liu, and Nancy Chen. 2023. Incontext Learning of Large Language Models for Controlled Dialogue Summarization: A Holistic Benchmark and Empirical Analysis. In Proceedings of the 4th
New Frontiers in Summarization Workshop, Yue Dong, Wen Xiao, Lu Wang, Fei
Liu, and Giuseppe Carenini (Eds.). Association for Computational Linguistics,
Singapore, 56–67. https://doi.org/10.18653/v1/2023.newsum-1.6
11
SIGIR ’26, Jul 20-24, 2026, Melbourne, Naarm, Australia Anon.
[78] Ellen Voorhees, Tasmeer Alam, Steven Bedrick, Dina Demner-Fushman,
William R. Hersh, Kyle Lo, Kirk Roberts, Ian Soboroff, and Lucy Lu Wang. 2021.
TREC-COVID: constructing a pandemic information retrieval test collection. SIGIR Forum 54, 1, Article 1 (Feb. 2021), 12 pages. https://doi.org/10.1145/3451964.
3451965
[79] Nikos Voskarides, Dan Li, Pengjie Ren, Evangelos Kanoulas, and Maarten de
Rijke. 2020. Query Resolution for Conversational Search with Limited Supervision. In Proceedings of the 43rd International ACM SIGIR Conference on
Research and Development in Information Retrieval (Virtual Event, China) (SIGIR ’20). Association for Computing Machinery, New York, NY, USA, 921–930.
https://doi.org/10.1145/3397271.3401130
[80] Zheng Wang, Bingzheng Gan, and Wei Shi. 2024. Multimodal Query Suggestion
with Multi-Agent Reinforcement Learning from Human Feedback. In Proceedings
of the ACM Web Conference 2024 (Singapore, Singapore) (WWW ’24). Association
for Computing Machinery, New York, NY, USA, 1374–1385. https://doi.org/10.
1145/3589334.3645365
[81] Zhenduo Wang, Zhichao Xu, Vivek Srikumar, and Qingyao Ai. 2024. An Indepth Investigation of User Response Simulation for Conversational Search. In
Proceedings of the ACM Web Conference 2024 (Singapore, Singapore) (WWW
’24). Association for Computing Machinery, New York, NY, USA, 1407–1418.
https://doi.org/10.1145/3589334.3645447
[82] William Webber, Alistair Moffat, and Justin Zobel. 2010. A similarity measure for
indefinite rankings. ACM Trans. Inf. Syst. 28, 4, Article 20 (Nov. 2010), 38 pages.
https://doi.org/10.1145/1852102.1852106
[83] Likang Wu, Zhi Zheng, Zhaopeng Qiu, Hao Wang, Hongchao Gu, Tingjia
Shen, Chuan Qin, Chen Zhu, Hengshu Zhu, Qi Liu, Hui Xiong, and Enhong
Chen. 2024. A Survey on Large Language Models for Recommendation.
arXiv:cs.IR/2305.19860 https://arxiv.org/abs/2305.19860
[84] Songhao Wu, Quan Tu, Hong Liu, Jia Xu, Zhongyi Liu, Guannan Zhang, Ran
Wang, Xiuying Chen, and Rui Yan. 2024. Unify Graph Learning with Text:
Unleashing LLM Potentials for Session Search. Proceedings of the ACM Web
Conference 2024 (2024). https://api.semanticscholar.org/CorpusID:269689150
[85] Fadhilah Mat Yamin and T Ramayah. 2011. User web search behavior on query
formulation. In 2011 International Conference on Semantic Technology and Information Retrieval. 182–188.
[86] HongChien Yu, Chenyan Xiong, and Jamie Callan. 2021. Improving Query
Representations for Dense Retrieval with Pseudo Relevance Feedback. In Proceedings of the 30th ACM International Conference on Information & Knowledge Management (Virtual Event, Queensland, Australia) (CIKM ’21). Association for Computing Machinery, New York, NY, USA, 3592–3596. https:
//doi.org/10.1145/3459637.3482124
[87] Xi Zhu, Yu Wang, Hang Gao, Wujiang Xu, Chen Wang, Zhiwei Liu, Kun Wang,
Mingyu Jin, Linsey Pang, Qingsong Weng, Philip S. Yu, and Yongfeng Zhang.
2025. Recommender Systems Meet Large Language Model Agents: A Survey.
Foundations and Trends® in Privacy and Security 7, 4 (2025), 247–396. https:
//doi.org/10.1561/3300000050
12