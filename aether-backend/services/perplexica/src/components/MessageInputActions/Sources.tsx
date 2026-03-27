import { useChat } from '@/lib/hooks/useChat';
import {
  Popover,
  PopoverButton,
  PopoverPanel,
  Switch,
} from '@headlessui/react';
import {
  GlobeIcon,
  GraduationCapIcon,
  NetworkIcon,
  ScalesIcon,
} from '@phosphor-icons/react';
import { AnimatePresence, motion } from 'motion/react';

const sourcesList = [
  {
    name: 'Web',
    key: 'web',
    icon: <GlobeIcon className="h-[16px] w-auto" />,
  },
  {
    name: 'Academic',
    key: 'academic',
    icon: <GraduationCapIcon className="h-[16px] w-auto" />,
  },
  {
    name: 'Social',
    key: 'discussions',
    icon: <NetworkIcon className="h-[16px] w-auto" />,
  },
  {
    name: 'Legal',
    key: 'legal',
    icon: <ScalesIcon className="h-[16px] w-auto" />,
  },
];

const Sources = () => {
  const { sources, setSources } = useChat();

  return (
    <Popover className="relative">
      {({ open }) => (
        <>
          <PopoverButton className="flex items-center justify-center active:border-none hover:bg-white/5 dark:hover:bg-white/5 p-2 rounded-lg focus:outline-none text-black/50 dark:text-white/50 active:scale-95 transition duration-200 hover:text-black dark:hover:text-white">
            <GlobeIcon className="h-[18px] w-auto" />
          </PopoverButton>
          <AnimatePresence>
            {open && (
              <PopoverPanel
                static
                className="absolute bottom-full mb-2 z-10 w-64 md:w-[225px] right-0"
              >
                <motion.div
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  transition={{ duration: 0.1, ease: 'easeOut' }}
                  className="origin-bottom-right flex flex-col glass-panel w-full p-1 max-h-[200px] md:max-h-none overflow-y-auto rounded-lg shadow-lg"
                >
                  {sourcesList.map((source, i) => (
                    <div
                      key={i}
                      className="flex flex-row justify-between hover:bg-white/10 dark:hover:bg-white/10 rounded-md py-3 px-2 cursor-pointer"
                      onClick={() => {
                        if (!sources.includes(source.key)) {
                          setSources([...sources, source.key]);
                        } else {
                          setSources(sources.filter((s) => s !== source.key));
                        }
                      }}
                    >
                      <div className="flex flex-row space-x-1.5 text-black/80 dark:text-white/80">
                        {source.icon}
                        <p className="text-xs">{source.name}</p>
                      </div>
                      <Switch
                        checked={sources.includes(source.key)}
                        className="group relative flex h-4 w-7 shrink-0 cursor-pointer rounded-full bg-light-200 dark:bg-white/10 p-0.5 duration-200 ease-in-out focus:outline-none transition-colors disabled:opacity-60 disabled:cursor-not-allowed data-[checked]:bg-sky-500 dark:data-[checked]:bg-sky-500"
                      >
                        <span
                          aria-hidden="true"
                          className="pointer-events-none inline-block size-3 translate-x-[1px] group-data-[checked]:translate-x-3 rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out"
                        />
                      </Switch>
                    </div>
                  ))}
                </motion.div>
              </PopoverPanel>
            )}
          </AnimatePresence>
        </>
      )}
    </Popover>
  );
};

export default Sources;
