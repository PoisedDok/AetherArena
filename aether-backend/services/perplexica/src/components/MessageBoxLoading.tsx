const MessageBoxLoading = () => {
  return (
    <div className="flex flex-col space-y-2 w-full lg:w-9/12 glass-surface animate-pulse rounded-lg py-3">
      <div className="h-2 rounded-full w-full glass-panel" />
      <div className="h-2 rounded-full w-9/12 glass-panel" />
      <div className="h-2 rounded-full w-10/12 glass-panel" />
    </div>
  );
};

export default MessageBoxLoading;
