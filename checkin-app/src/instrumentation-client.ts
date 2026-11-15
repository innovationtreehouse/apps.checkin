// Runs once in the browser before the app hydrates, so the first page's calls are tagged too.
import { installPageViewTagging } from "@/lib/pageViewTagging";

installPageViewTagging(window);
