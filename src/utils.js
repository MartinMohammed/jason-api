async function getUserInformationBasedOnUserId(userId) {
  return new Promise((resolve, reject) => {
    // Initiator
    if (userId === "1") {
      // mock api call
      const user = {
        id: userId,
        name: "Shuti",
        phoneNumber: "+491709004593",
        friendUserIds: "2,3",
      };
      // do I need to wait for 1 second?
      setTimeout(() => {
        // do I need return resolve?
        return resolve(user);
      }, 1000);
    } else if (userId === "2") {
      // mock api call
      const user = {
        id: userId,
        name: "Son",
        phoneNumber: "+4915229591653",
        friendUserIds: "2",
      };
      setTimeout(() => {
        // do I need return resolve?
        return resolve(user);
      }, 1000);
    } else if (userId === "3") {
      // mock api call
      const user = {
        id: userId,
        name: "Martin",
        phoneNumber: "+491794661350",
      };
      setTimeout(() => {
        // do I need return resolve?
        return resolve(user);
      }, 1000);
    }
  });
}

export { getUserInformationBasedOnUserId };
