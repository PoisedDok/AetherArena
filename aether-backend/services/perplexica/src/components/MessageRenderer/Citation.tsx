const Citation = ({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) => {
  return (
    <a
      href={href}
      target="_blank"
      className="glass-panel px-1 rounded ml-1 no-underline text-xs text-[#6f86e6] dark:text-[#8fa9ff] hover:text-[#8fa9ff] dark:hover:text-[#b3c3ff] relative transition-colors duration-150"
    >
      {children}
    </a>
  );
};

export default Citation;
