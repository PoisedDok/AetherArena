import ChatWindow from '@/components/ChatWindow';
import { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Research - AetherArena',
  description: 'AI-powered research and knowledge discovery.',
};

const Home = () => {
  return <ChatWindow />;
};

export default Home;
